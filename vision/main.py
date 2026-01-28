"""
Vision & Robot Command Service for Elegoo Robot Car MCP

Provides:
- MiDaS depth estimation and YOLOv8 object detection via HTTP API
- Centralized robot command dispatcher (all robot commands go through here)

This is the SINGLE point of communication with the robot.
Node MCP server calls these endpoints instead of direct TCP.
"""
import base64
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
import cv2
import numpy as np

import threading
import time as time_module
from dataclasses import dataclass, field
from typing import List

from models import DepthEstimator, ObjectDetector
from robot_client import RobotClient, CameraStream, get_robot, get_camera
from montage import (
    get_journey_montage, load_nudges, save_nudges, update_nudge,
    load_decision_queue, clear_decision_queue
)
from store import get_store

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model instances (loaded once at startup)
depth_estimator: Optional[DepthEstimator] = None
object_detector: Optional[ObjectDetector] = None


# === Background Vision Processor ===
# Runs depth estimation continuously, caches results for fast access


@dataclass
class VisionResult:
    """Cached vision processing result."""
    timestamp_ms: int = 0
    frame_base64: Optional[str] = None
    depth_image_base64: Optional[str] = None
    annotated_image_base64: Optional[str] = None
    depth_zones: dict = field(default_factory=lambda: {"left": 0, "center": 0, "right": 0})
    center_depth: float = 0.0
    detected_objects: List[dict] = field(default_factory=list)
    processing_ms: float = 0.0
    frame_width: int = 0
    frame_height: int = 0


class VisionProcessor:
    """
    Background thread that continuously processes camera frames.

    Runs depth estimation (and optionally detection) at configurable rate,
    caching results for instant access by decision loop and UI.
    """

    def __init__(
        self,
        camera: CameraStream,
        depth_model: DepthEstimator,
        detection_model: Optional[ObjectDetector] = None,
        target_fps: float = 10.0,
        run_detection: bool = False,
        detection_interval: int = 3,  # Run detection every N frames
    ):
        self.camera = camera
        self.depth_model = depth_model
        self.detection_model = detection_model
        self.target_fps = target_fps
        self.run_detection = run_detection
        self.detection_interval = detection_interval

        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

        # Cached result
        self._latest = VisionResult()

        # Stats
        self._frame_count = 0
        self._total_processing_ms = 0.0
        self._detection_count = 0

    def start(self):
        """Start background processing thread."""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._process_loop, daemon=True)
        self._thread.start()
        logger.info(f"VisionProcessor started at {self.target_fps} fps")

    def stop(self):
        """Stop background processing."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        logger.info("VisionProcessor stopped")

    def get_latest(self) -> VisionResult:
        """Get latest cached vision result (thread-safe, instant)."""
        with self._lock:
            return self._latest

    def get_stats(self) -> dict:
        """Get processing statistics."""
        avg_ms = self._total_processing_ms / max(self._frame_count, 1)
        return {
            "running": self._running,
            "target_fps": self.target_fps,
            "frames_processed": self._frame_count,
            "detections_run": self._detection_count,
            "avg_processing_ms": round(avg_ms, 1),
            "detection_enabled": self.run_detection,
        }

    def set_detection(self, enabled: bool):
        """Enable/disable detection processing."""
        self.run_detection = enabled
        logger.info(f"Detection {'enabled' if enabled else 'disabled'}")

    def _process_loop(self):
        """Main processing loop - runs in background thread."""
        target_interval = 1.0 / self.target_fps

        while self._running:
            loop_start = time_module.time()

            try:
                self._process_frame()
            except Exception as e:
                logger.warning(f"Vision processing error: {e}")

            # Maintain target FPS
            elapsed = time_module.time() - loop_start
            sleep_time = target_interval - elapsed
            if sleep_time > 0:
                time_module.sleep(sleep_time)

    def _process_frame(self):
        """Process a single frame."""
        # Get latest camera frame
        frame = self.camera.get_frame()
        if frame is None:
            return

        start_time = time_module.time()
        timestamp_ms = int(start_time * 1000)

        # Convert to PIL for models
        image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

        # Always run depth estimation
        depth_result = self.depth_model.estimate(image, include_image=True)

        # Encode camera frame
        _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        frame_base64 = base64.b64encode(buffer).decode('utf-8')

        # Build result
        result = VisionResult(
            timestamp_ms=timestamp_ms,
            frame_base64=frame_base64,
            depth_image_base64=depth_result.get("depth_image"),
            depth_zones=depth_result.get("depth_zones", {"left": 0, "center": 0, "right": 0}),
            center_depth=depth_result.get("center_depth", 0),
            frame_width=frame.shape[1],
            frame_height=frame.shape[0],
        )

        # Run detection periodically if enabled
        if self.run_detection and self.detection_model and self._frame_count % self.detection_interval == 0:
            try:
                detection_result = self.detection_model.detect(
                    image, confidence_threshold=0.35, include_image=True
                )
                result.detected_objects = detection_result.get("detected_objects", [])
                result.annotated_image_base64 = detection_result.get("annotated_image")
                self._detection_count += 1

                # Add bearing to each object
                for obj in result.detected_objects:
                    if "bbox" in obj:
                        bbox = obj["bbox"]
                        center_x = (bbox["x1"] + bbox["x2"]) / 2
                        obj["bearing_deg"] = round((center_x / frame.shape[1] - 0.5) * 60, 1)
            except Exception as e:
                logger.warning(f"Detection failed: {e}")

        # Calculate processing time
        result.processing_ms = (time_module.time() - start_time) * 1000

        # Update cache (thread-safe)
        with self._lock:
            self._latest = result

        self._frame_count += 1
        self._total_processing_ms += result.processing_ms


# Global vision processor instance
vision_processor: Optional[VisionProcessor] = None


def get_vision_processor() -> Optional[VisionProcessor]:
    """Get the global vision processor instance."""
    return vision_processor


def warmup_models(depth: DepthEstimator, detector: ObjectDetector) -> None:
    """
    Run warmup inference on both models.

    This primes PyTorch JIT compilation and ensures the first real
    inference is fast. Uses a small dummy image to minimize warmup time.
    """
    import time
    import numpy as np

    logger.info("Running warmup inference...")

    # Create a small dummy image (320x240 RGB)
    dummy_array = np.random.randint(0, 255, (240, 320, 3), dtype=np.uint8)
    dummy_image = Image.fromarray(dummy_array)

    # Warmup depth estimation
    start = time.time()
    depth.estimate(dummy_image)
    depth_time = (time.time() - start) * 1000
    logger.info(f"Depth warmup complete: {depth_time:.0f}ms")

    # Warmup object detection
    start = time.time()
    detector.detect(dummy_image)
    detect_time = (time.time() - start) * 1000
    logger.info(f"Detection warmup complete: {detect_time:.0f}ms")

    logger.info(f"Warmup complete! Models primed for fast inference.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models at startup, cleanup at shutdown."""
    global depth_estimator, object_detector, vision_processor

    # Initialize robot client
    robot_host = os.environ.get("ROBOT_HOST", "192.168.4.1")
    robot_port = int(os.environ.get("ROBOT_PORT", "100"))
    camera_url = os.environ.get("CAMERA_URL", f"http://{robot_host}:81/stream")

    logger.info(f"Robot host: {robot_host}:{robot_port}")
    logger.info(f"Camera URL: {camera_url}")

    # Get singleton instances (they'll be initialized with these settings)
    robot = RobotClient.get_instance(robot_host, robot_port)
    camera = CameraStream.get_instance(camera_url)

    # Try to connect to robot (non-blocking, will reconnect on first command if needed)
    if robot.connect():
        logger.info("Robot connected!")
    else:
        logger.warning("Robot not connected - will retry on first command")

    # Start camera stream in background
    camera.start()

    # Load vision models
    logger.info("Loading vision models...")

    # Load MiDaS (small model for speed)
    logger.info("Loading MiDaS depth estimator...")
    depth_estimator = DepthEstimator(model_type="MiDaS_small")

    # Load YOLOv8 (nano model for speed)
    logger.info("Loading YOLOv8 object detector...")
    object_detector = ObjectDetector(model_size="yolov8n")

    logger.info("Vision models loaded successfully!")

    # Warmup inference to prime JIT compilation
    warmup_models(depth_estimator, object_detector)

    # Start background vision processor
    # Default 5 fps - enough for navigation, easy on CPU
    # Set VISION_FPS env var to adjust
    vision_fps = float(os.environ.get("VISION_FPS", "5"))
    vision_processor = VisionProcessor(
        camera=camera,
        depth_model=depth_estimator,
        detection_model=object_detector,
        target_fps=vision_fps,
        run_detection=False,  # Detection on demand, not continuous
        detection_interval=3,  # When enabled, run every 3rd frame
    )
    vision_processor.start()

    yield

    # Cleanup
    logger.info("Shutting down...")
    if vision_processor:
        vision_processor.stop()
    camera.stop()
    robot.stop()
    robot.disconnect()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="Elegoo Vision Service",
    description="MiDaS depth estimation and YOLOv8 object detection for robot navigation",
    version="1.0.0",
    lifespan=lifespan,
)


class AnalyzeRequest(BaseModel):
    """Request body for /analyze endpoint."""

    image_base64: str
    run_depth: bool = True
    run_detection: bool = True
    detection_confidence: float = 0.25
    include_images: bool = False  # Return visualization images (depth colormap, annotated)


class AnalyzeResponse(BaseModel):
    """Response from /analyze endpoint."""

    success: bool
    depth: Optional[dict] = None
    detection: Optional[dict] = None
    depth_image: Optional[str] = None  # base64 depth colormap
    annotated_image: Optional[str] = None  # base64 image with bounding boxes
    error: Optional[str] = None


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    processor = get_vision_processor()
    return {
        "status": "ok",
        "models_loaded": depth_estimator is not None and object_detector is not None,
        "vision_processor_running": processor is not None and processor._running,
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_image(request: AnalyzeRequest):
    """
    Analyze an image for depth and/or object detection.

    Request body:
        - image_base64: Base64-encoded JPEG image
        - run_depth: Whether to run MiDaS depth estimation (default: true)
        - run_detection: Whether to run YOLOv8 detection (default: true)
        - detection_confidence: Confidence threshold for detection (default: 0.25)
        - include_images: Whether to return visualization images (default: false)

    Returns:
        - depth: Depth estimation results (if run_depth=true)
        - detection: Object detection results (if run_detection=true)
        - depth_image: Base64 colormap visualization (if include_images=true)
        - annotated_image: Base64 image with bounding boxes (if include_images=true)
    """
    if not depth_estimator or not object_detector:
        raise HTTPException(status_code=503, detail="Models not loaded")

    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64)
        image = Image.open(io.BytesIO(image_data)).convert("RGB")

        result: dict = {"success": True}

        # Run depth estimation
        if request.run_depth:
            depth_result = depth_estimator.estimate(
                image, include_image=request.include_images
            )
            # Extract image from result if present
            if "depth_image" in depth_result:
                result["depth_image"] = depth_result.pop("depth_image")
            result["depth"] = depth_result

        # Run object detection
        if request.run_detection:
            detection_result = object_detector.detect(
                image,
                confidence_threshold=request.detection_confidence,
                include_image=request.include_images,
            )
            # Extract image from result if present
            if "annotated_image" in detection_result:
                result["annotated_image"] = detection_result.pop("annotated_image")
            result["detection"] = detection_result

        return result

    except Exception as e:
        logger.error(f"Error analyzing image: {e}")
        return AnalyzeResponse(success=False, error=str(e))


# === Robot Command Endpoints ===
# All robot communication goes through these endpoints.
# Node MCP server calls these instead of direct TCP.


class DriveRequest(BaseModel):
    """Request body for /robot/drive endpoint."""
    direction: Literal["forward", "backward", "left", "right", "stop"]
    speed: int = 50  # 0-100
    duration_ms: int = 0  # 0 = no auto-stop


class TurnRequest(BaseModel):
    """Request body for /robot/turn endpoint."""
    degrees: int  # Positive = clockwise, negative = counter-clockwise
    speed: int = 50


class LookRequest(BaseModel):
    """Request body for /robot/look endpoint."""
    angle: int  # 0-180, 90 = center


class LedRequest(BaseModel):
    """Request body for /robot/led endpoint."""
    r: int = 0
    g: int = 0
    b: int = 0
    led: int = 0  # 0 = all LEDs


class RawCommandRequest(BaseModel):
    """Request body for /robot/raw endpoint (advanced use)."""
    n: int  # Command number
    d1: int = 0
    d2: int = 0
    d3: int = 0
    d4: int = 0


@app.post("/robot/drive")
async def robot_drive(request: DriveRequest):
    """Drive the robot in a direction."""
    robot = get_robot()
    return robot.drive(request.direction, request.speed, request.duration_ms)


@app.post("/robot/turn")
async def robot_turn(request: TurnRequest):
    """Turn the robot in place."""
    robot = get_robot()
    return robot.turn(request.degrees, request.speed)


@app.post("/robot/stop")
async def robot_stop():
    """Emergency stop all motors."""
    robot = get_robot()
    return robot.stop()


@app.post("/robot/look")
async def robot_look(request: LookRequest):
    """Set camera pan servo angle."""
    robot = get_robot()
    return robot.look(request.angle)


@app.get("/robot/distance")
async def robot_distance():
    """Read ultrasonic distance sensor."""
    robot = get_robot()
    return robot.get_distance()


@app.get("/robot/ping")
async def robot_ping():
    """Ping robot to check connection."""
    robot = get_robot()
    return robot.ping()


@app.get("/robot/metrics")
async def robot_metrics():
    """Get connection metrics."""
    robot = get_robot()
    return robot.get_metrics()


@app.post("/robot/led")
async def robot_led(request: LedRequest):
    """Set LED color."""
    robot = get_robot()
    return robot.set_led(request.r, request.g, request.b, request.led)


@app.post("/robot/raw")
async def robot_raw(request: RawCommandRequest):
    """Send raw command to robot (advanced use)."""
    robot = get_robot()
    success, latency, response = robot.send_raw(
        request.n, request.d1, request.d2, request.d3, request.d4
    )
    return {
        "success": success,
        "latency_ms": round(latency, 1),
        "response": response,
    }


# === Camera Endpoints ===


@app.get("/camera/capture")
async def camera_capture():
    """Capture current frame from camera stream as base64 JPEG."""
    camera = get_camera()
    frame = camera.get_frame()

    if frame is None:
        raise HTTPException(status_code=503, detail="No camera frame available")

    # Encode frame as JPEG
    _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    image_base64 = base64.b64encode(buffer).decode('utf-8')

    return {
        "success": True,
        "image_base64": image_base64,
        "frame_age_ms": round(camera.get_frame_age_ms(), 1),
        "width": frame.shape[1],
        "height": frame.shape[0],
    }


@app.get("/camera/status")
async def camera_status():
    """Get camera stream status."""
    camera = get_camera()
    return camera.get_status()


@app.post("/camera/start")
async def camera_start():
    """Start camera stream (if not already running)."""
    camera = get_camera()
    success = camera.start()
    return {"success": success, "status": camera.get_status()}


@app.post("/camera/stop")
async def camera_stop():
    """Stop camera stream."""
    camera = get_camera()
    camera.stop()
    return {"success": True}


# === Vision Processing Endpoints ===
# Background processor runs depth estimation continuously at 10fps.
# These endpoints return cached results instantly (no computation delay).


@app.get("/vision/latest")
async def vision_latest():
    """
    Get latest cached vision results (instant, no computation).

    The background processor runs depth estimation at 10fps.
    This endpoint returns the most recent result.

    Returns:
        - depth_zones: {left, center, right} percentages (0-100, higher = closer)
        - center_depth: center zone depth percentage
        - timestamp_ms: when this frame was processed
        - age_ms: how old this result is
        - processing_ms: how long depth estimation took
        - detected_objects: list of detected objects (if detection enabled)
    """
    processor = get_vision_processor()
    if not processor:
        raise HTTPException(status_code=503, detail="Vision processor not running")

    result = processor.get_latest()
    now_ms = int(time_module.time() * 1000)

    return {
        "success": True,
        "depth_zones": result.depth_zones,
        "center_depth": result.center_depth,
        "timestamp_ms": result.timestamp_ms,
        "age_ms": now_ms - result.timestamp_ms,
        "processing_ms": round(result.processing_ms, 1),
        "detected_objects": result.detected_objects,
        "frame_size": {"width": result.frame_width, "height": result.frame_height},
    }


@app.get("/vision/latest/frame")
async def vision_latest_frame():
    """
    Get latest camera frame with depth overlay (instant).

    Returns base64 JPEG images:
        - frame_base64: raw camera frame
        - depth_image_base64: depth colormap visualization
        - annotated_image_base64: frame with detection boxes (if detection enabled)
    """
    processor = get_vision_processor()
    if not processor:
        raise HTTPException(status_code=503, detail="Vision processor not running")

    result = processor.get_latest()
    now_ms = int(time_module.time() * 1000)

    return {
        "success": True,
        "frame_base64": result.frame_base64,
        "depth_image_base64": result.depth_image_base64,
        "annotated_image_base64": result.annotated_image_base64,
        "timestamp_ms": result.timestamp_ms,
        "age_ms": now_ms - result.timestamp_ms,
    }


@app.get("/vision/latest/full")
async def vision_latest_full():
    """
    Get complete cached vision result (depth + detection + images).

    Combines all vision data in one response for dashboard use.
    """
    processor = get_vision_processor()
    if not processor:
        raise HTTPException(status_code=503, detail="Vision processor not running")

    result = processor.get_latest()
    now_ms = int(time_module.time() * 1000)

    return {
        "success": True,
        "timestamp_ms": result.timestamp_ms,
        "age_ms": now_ms - result.timestamp_ms,
        "processing_ms": round(result.processing_ms, 1),
        "depth": {
            "zones": result.depth_zones,
            "center": result.center_depth,
        },
        "detection": {
            "objects": result.detected_objects,
            "count": len(result.detected_objects),
        },
        "images": {
            "frame": result.frame_base64,
            "depth": result.depth_image_base64,
            "annotated": result.annotated_image_base64,
        },
        "frame_size": {"width": result.frame_width, "height": result.frame_height},
    }


@app.get("/vision/stats")
async def vision_stats():
    """Get vision processor statistics."""
    processor = get_vision_processor()
    if not processor:
        raise HTTPException(status_code=503, detail="Vision processor not running")

    return processor.get_stats()


@app.post("/vision/detection")
async def vision_detection_toggle(enabled: bool = True):
    """
    Enable/disable object detection in background processor.

    Detection is more expensive than depth estimation.
    Enable when you need semantic understanding (look_for/avoid nudges).
    """
    processor = get_vision_processor()
    if not processor:
        raise HTTPException(status_code=503, detail="Vision processor not running")

    processor.set_detection(enabled)
    return {"success": True, "detection_enabled": enabled}


# === Claude Copilot Endpoints ===
# Montage and nudge system for Claude to review journey and provide navigation hints


class NudgeRequest(BaseModel):
    """Request body for /nudge endpoint."""
    active: Optional[bool] = None
    goal: Optional[str] = None
    prefer_direction: Optional[Literal["left", "right"]] = None
    bias_strength: Optional[float] = None  # 0.0-1.0
    look_for: Optional[list[str]] = None  # Objects to seek
    avoid: Optional[list[str]] = None  # Objects to avoid
    notes: Optional[str] = None


@app.get("/montage")
async def get_montage(count: int = 6):
    """
    Get a montage of recent drive snapshots for Claude to review.

    Args:
        count: Number of snapshots to include (default: 6)

    Returns:
        - success: Whether montage was created
        - image_base64: Base64 JPEG of the montage grid
        - snapshot_count: Number of snapshots included
        - snapshots: List of snapshot filenames
        - width/height: Montage dimensions
    """
    result = get_journey_montage(count)
    if not result["success"]:
        raise HTTPException(status_code=404, detail=result.get("error", "No snapshots available"))
    return result


@app.get("/nudges")
async def get_nudges():
    """Get current navigation nudges."""
    return load_nudges()


@app.post("/nudge")
async def set_nudge(request: NudgeRequest):
    """
    Set navigation nudges for Claude copilot mode.

    The autonomous driver hot-reloads these nudges to bias its decisions.

    Args:
        - active: Enable/disable nudge system
        - goal: High-level goal description (e.g., "find the kitchen")
        - prefer_direction: Bias toward "left" or "right"
        - bias_strength: How strongly to apply bias (0.0-1.0, default 0.3)
        - look_for: Objects to seek (e.g., ["chair", "table"])
        - avoid: Objects to avoid (e.g., ["person", "dog"])
        - notes: Freeform notes

    Returns:
        Updated nudge settings
    """
    current = load_nudges()

    # Update only provided fields
    if request.active is not None:
        current["active"] = request.active
    if request.goal is not None:
        current["goal"] = request.goal
    if request.prefer_direction is not None:
        current["prefer_direction"] = request.prefer_direction
    if request.bias_strength is not None:
        current["bias_strength"] = max(0.0, min(1.0, request.bias_strength))
    if request.look_for is not None:
        current["look_for"] = request.look_for
    if request.avoid is not None:
        current["avoid"] = request.avoid
    if request.notes is not None:
        current["notes"] = request.notes

    save_nudges(current)
    return current


@app.post("/nudge/clear")
async def clear_nudges():
    """Reset nudges to default (inactive) state."""
    default_nudges = {
        "active": False,
        "goal": None,
        "prefer_direction": None,
        "bias_strength": 0.3,
        "look_for": [],
        "avoid": [],
        "notes": "Claude's navigation hints - hot-reloaded by driver"
    }
    save_nudges(default_nudges)
    return default_nudges


# === Decision Queue Endpoints ===
# For dashboard visualization of autonomous driver decisions


@app.get("/api/decisions")
async def get_decisions():
    """
    Get recent autonomous driver decisions for dashboard visualization.
    Returns the last 20 decisions with trace information.
    """
    nudges = load_nudges()
    return {
        "copilot_active": nudges.get("active", False),
        "decisions": load_decision_queue(),
    }


@app.delete("/api/decisions")
async def clear_decisions():
    """Clear the decision queue."""
    clear_decision_queue()
    return {"cleared": True}


# === State Store Endpoints ===
# Waypoints, position, and session data


class WaypointRequest(BaseModel):
    """Request body for /waypoint endpoint."""
    name: str
    x: Optional[float] = None  # If None, uses current position
    y: Optional[float] = None
    heading: Optional[float] = None


@app.get("/waypoints")
async def list_waypoints():
    """List all saved waypoints."""
    store = get_store()
    waypoints = store.list_waypoints()
    return [
        {
            "name": w.name,
            "x": round(w.x, 1),
            "y": round(w.y, 1),
            "heading": round(w.heading, 1),
            "created_at": w.created_at
        }
        for w in waypoints
    ]


@app.post("/waypoint")
async def save_waypoint(request: WaypointRequest):
    """
    Save current position as a named waypoint.
    If x/y/heading provided, uses those values instead of current position.
    """
    store = get_store()
    waypoint = store.save_waypoint(
        name=request.name,
        x=request.x,
        y=request.y,
        heading=request.heading
    )
    return {
        "success": True,
        "name": waypoint.name,
        "x": round(waypoint.x, 1),
        "y": round(waypoint.y, 1),
        "heading": round(waypoint.heading, 1)
    }


@app.get("/waypoint/{name}")
async def get_waypoint(name: str):
    """Get a waypoint by name."""
    store = get_store()
    waypoint = store.get_waypoint(name)
    if not waypoint:
        raise HTTPException(status_code=404, detail=f"Waypoint '{name}' not found")
    return {
        "name": waypoint.name,
        "x": round(waypoint.x, 1),
        "y": round(waypoint.y, 1),
        "heading": round(waypoint.heading, 1),
        "created_at": waypoint.created_at
    }


@app.delete("/waypoint/{name}")
async def delete_waypoint(name: str):
    """Delete a waypoint by name."""
    store = get_store()
    deleted = store.delete_waypoint(name)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Waypoint '{name}' not found")
    return {"success": True, "deleted": name}


# === Position Endpoints ===


@app.get("/position")
async def get_position():
    """Get current robot position estimate (dead reckoning)."""
    store = get_store()
    pos = store.get_position()
    return {
        "x": round(pos.x, 1),
        "y": round(pos.y, 1),
        "heading": round(pos.heading, 1)
    }


@app.post("/position/reset")
async def reset_position():
    """Reset position to origin (0, 0, 0)."""
    store = get_store()
    store.reset_position()
    return {"success": True, "x": 0, "y": 0, "heading": 0}


class PositionUpdateRequest(BaseModel):
    """Request body for position update."""
    x: float
    y: float
    heading: float


@app.post("/position")
async def set_position(request: PositionUpdateRequest):
    """Manually set robot position (e.g., after manual repositioning)."""
    store = get_store()
    store.set_position(request.x, request.y, request.heading)
    return {
        "success": True,
        "x": round(request.x, 1),
        "y": round(request.y, 1),
        "heading": round(request.heading, 1)
    }


# === Session Endpoints ===


@app.get("/sessions")
async def list_sessions(limit: int = 10):
    """Get recent driving sessions."""
    store = get_store()
    sessions = store.get_recent_sessions(limit)
    return [
        {
            "id": s.id,
            "started_at": s.started_at,
            "ended_at": s.ended_at,
            "duration_s": round(s.duration_s, 1),
            "distance_cm": round(s.distance_cm, 1),
            "cells_visited": s.cells_visited,
            "decisions": s.decisions,
            "goal": s.goal
        }
        for s in sessions
    ]


@app.get("/session/{session_id}")
async def get_session(session_id: int):
    """Get a specific session by ID."""
    store = get_store()
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return {
        "id": session.id,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "duration_s": round(session.duration_s, 1),
        "distance_cm": round(session.distance_cm, 1),
        "cells_visited": session.cells_visited,
        "decisions": session.decisions,
        "goal": session.goal
    }


# === Store Stats ===


@app.get("/store/stats")
async def store_stats():
    """Get database statistics."""
    store = get_store()
    return store.get_stats()


@app.post("/store/clear")
async def clear_store():
    """Clear all store data (sessions, grid) but keep waypoints."""
    store = get_store()
    store.clear_grid()
    store.reset_position()
    return {"success": True, "message": "Grid and position cleared. Waypoints preserved."}


# === Dashboard API Endpoints ===
# These endpoints match the dashboard/API.md contract for real-time visualization


class CommandRequest(BaseModel):
    """Request body for /api/command endpoint."""
    command: Literal["drive", "turn", "stop", "explore"]
    params: Optional[dict] = None


@app.get("/api/snapshot")
async def dashboard_snapshot():
    """
    Combined snapshot for dashboard polling.
    Returns robot state, camera frame, depth analysis, and object detection.

    Now uses cached results from background vision processor (instant, no computation).
    Can be polled at 10fps for smooth UI updates.
    """
    robot = get_robot()
    store = get_store()

    timestamp_ms = int(time_module.time() * 1000)
    robot_connected = robot.is_connected()
    processor = get_vision_processor()
    vision_available = processor is not None

    result = {
        "timestamp": timestamp_ms,
        "robot_connected": robot_connected,
        "vision_available": vision_available,
        "camera_image": None,
        "depth_image": None,
        "annotated_image": None,
        "depth": None,
        "detection": None,
        "world_state": _build_world_state(robot, get_camera(), store, timestamp_ms),
    }

    # Get cached vision results (instant - no computation)
    if processor:
        vision = processor.get_latest()

        result["camera_image"] = vision.frame_base64
        result["depth_image"] = vision.depth_image_base64
        result["annotated_image"] = vision.annotated_image_base64

        if vision.timestamp_ms > 0:
            result["depth"] = {
                "center_depth": vision.center_depth,
                "depth_zones": vision.depth_zones,
                "image_size": {"width": vision.frame_width, "height": vision.frame_height},
                "age_ms": timestamp_ms - vision.timestamp_ms,
                "processing_ms": vision.processing_ms,
            }

            if vision.detected_objects:
                result["detection"] = {
                    "detected_objects": vision.detected_objects,
                    "count": len(vision.detected_objects),
                }

    return result


def _build_world_state(robot: RobotClient, camera, store, timestamp_ms: int) -> dict:
    """Build WorldState object matching the API contract."""
    metrics = robot.get_metrics()
    pos = store.get_position()

    return {
        "schema_version": "1.0",
        "timestamp_ms": timestamp_ms,

        "autonomy_state": "IDLE",  # Updated by driver when running
        "last_action": "none",
        "stuck_counter": 0,

        "geometry": {
            "front_min_mm": 500,  # Placeholder - would come from depth
            "scan_bins_mm": [],
            "best_gap": None,
        },

        "semantics": {
            "detected_objects": [],  # Populated from detection above
            "current_place_tags": [],
        },

        "map_summary": {
            "current_place": None,
            "nearby_places": [],
            "unexplored_frontiers": 0,
            "loop_closure": {
                "candidates": [],
                "confidence": 0,
            },
        },

        "confidence": {
            "localization": 0.5,
            "safety": 0.8,
            "loop_closure": 0,
        },

        "health": {
            "link_rtt_ms": metrics.get("avg_latency_ms", 0),
            "command_age_ms": 0,
            "dropped_frames": metrics.get("failures", 0),
            "last_heartbeat_ms": 0,
            "battery_voltage": 7.4,  # Placeholder
            "queue_depth": 0,
        },

        "position": {
            "x": pos.x,
            "y": pos.y,
            "heading": pos.heading,
        },
    }


@app.post("/api/command")
async def dashboard_command(request: CommandRequest):
    """
    Unified command interface for dashboard control.

    Commands:
        - drive: { direction, speed?, duration_ms? }
        - turn: { degrees, speed? }
        - stop: (no params)
        - explore: { duration_s? }
    """
    robot = get_robot()
    params = request.params or {}

    try:
        if request.command == "drive":
            direction = params.get("direction", "stop")
            speed = params.get("speed", 50)
            duration_ms = params.get("duration_ms", 300)
            result = robot.drive(direction, speed, duration_ms)
            return {"success": result.get("success", False), "message": f"Driving {direction}"}

        elif request.command == "turn":
            degrees = params.get("degrees", 0)
            speed = params.get("speed", 40)
            result = robot.turn(degrees, speed)
            return {"success": result.get("success", False), "message": f"Turning {degrees}°"}

        elif request.command == "stop":
            result = robot.stop()
            return {"success": result.get("success", False), "message": "Stopped"}

        elif request.command == "explore":
            # This would start autonomous exploration
            # For now, return not implemented
            return {"success": False, "error": "Autonomous explore via API not yet implemented. Use vision driver."}

        else:
            return {"success": False, "error": f"Unknown command: {request.command}"}

    except Exception as e:
        logger.error(f"Command error: {e}")
        return {"success": False, "error": str(e)}


# === Combined Status ===


@app.get("/status")
async def full_status():
    """Get full status of robot, camera, vision models, and store."""
    robot = get_robot()
    camera = get_camera()
    store = get_store()
    processor = get_vision_processor()

    vision_status = {
        "depth_loaded": depth_estimator is not None,
        "detection_loaded": object_detector is not None,
    }

    if processor:
        vision_status["processor"] = processor.get_stats()

    return {
        "robot": {
            "connected": robot.is_connected(),
            "metrics": robot.get_metrics(),
        },
        "camera": camera.get_status(),
        "vision": vision_status,
        "store": store.get_stats(),
    }


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VISION_HOST", "0.0.0.0")
    port = int(os.environ.get("VISION_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
