"""
Vision Service for Elegoo Robot Car MCP
Provides MiDaS depth estimation and YOLOv8 object detection via HTTP API.
"""
import base64
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

from models import DepthEstimator, ObjectDetector

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

    # Cleanup (if needed)
    logger.info("Shutting down vision service...")


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


class AnalyzeResponse(BaseModel):
    """Response from /analyze endpoint."""

    success: bool
    depth: Optional[dict] = None
    detection: Optional[dict] = None
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

    Returns:
        - depth: Depth estimation results (if run_depth=true)
        - detection: Object detection results (if run_detection=true)
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
            depth_result = depth_estimator.estimate(image)
            result["depth"] = depth_result

        # Run object detection
        if request.run_detection:
            detection_result = object_detector.detect(
                image, confidence_threshold=request.detection_confidence
            )
            result["detection"] = detection_result

        return result

    except Exception as e:
        logger.error(f"Error analyzing image: {e}")
        return AnalyzeResponse(success=False, error=str(e))


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VISION_HOST", "0.0.0.0")
    port = int(os.environ.get("VISION_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
