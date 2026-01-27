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

from models import DepthEstimator, ObjectDetector
from robot_client import RobotClient, CameraStream, get_robot, get_camera
from montage import get_journey_montage, load_nudges, save_nudges, update_nudge

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model instances (loaded once at startup)
depth_estimator: Optional[DepthEstimator] = None
object_detector: Optional[ObjectDetector] = None


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
    global depth_estimator, object_detector

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

    yield

    # Cleanup
    logger.info("Shutting down...")
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
    return {
        "status": "ok",
        "models_loaded": depth_estimator is not None and object_detector is not None,
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


# === Combined Status ===


@app.get("/status")
async def full_status():
    """Get full status of robot, camera, and vision models."""
    robot = get_robot()
    camera = get_camera()

    return {
        "robot": {
            "connected": robot.is_connected(),
            "metrics": robot.get_metrics(),
        },
        "camera": camera.get_status(),
        "vision": {
            "depth_loaded": depth_estimator is not None,
            "detection_loaded": object_detector is not None,
        },
    }


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VISION_HOST", "0.0.0.0")
    port = int(os.environ.get("VISION_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
