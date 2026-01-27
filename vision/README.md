# Elegoo Vision Service

Python FastAPI service providing MiDaS depth estimation and YOLOv8 object detection for the Elegoo Robot Car MCP server.

## Features

- **MiDaS Depth Estimation**: Estimates relative distances from a single camera image
- **YOLOv8 Object Detection**: Detects and labels objects with bounding boxes and bearing angles
- **FastAPI HTTP Interface**: Easy integration with the Node.js MCP server
- **Warmup Inference**: Models are primed at startup for fast response times
- **Auto-managed**: Node MCP server automatically starts/stops the Python service

## Auto-Start (Recommended)

The Node MCP server automatically manages this Python service. Just run:

```bash
cd server
npm start
```

The vision service will:
1. Start automatically as a child process
2. Load models and run warmup inference
3. Be monitored and restarted if it crashes
4. Shut down cleanly when the MCP server stops

To disable auto-start: `VISION_AUTO_START=false npm start`

## Manual Setup (Optional)

If you prefer to run the vision service separately:

1. Create a virtual environment:
   ```bash
   cd vision
   python3 -m venv venv
   source venv/bin/activate  # Linux/Mac
   # or: venv\Scripts\activate  # Windows
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the service:
   ```bash
   python main.py
   # or: uvicorn main:app --host 0.0.0.0 --port 8765
   ```

## API Endpoints

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "models_loaded": true
}
```

### POST /analyze

Analyze an image for depth and object detection.

**Request:**
```json
{
  "image_base64": "<base64-encoded JPEG>",
  "run_depth": true,
  "run_detection": true,
  "detection_confidence": 0.25
}
```

**Response:**
```json
{
  "success": true,
  "depth": {
    "center_depth": 0.65,
    "depth_zones": {
      "left": 0.45,
      "center": 0.65,
      "right": 0.52
    },
    "image_size": {"width": 640, "height": 480}
  },
  "detection": {
    "detected_objects": [
      {
        "label": "chair",
        "bearing_deg": -12.5,
        "confidence": 0.87,
        "bbox": {"x1": 100, "y1": 200, "x2": 250, "y2": 450}
      }
    ],
    "count": 1
  }
}
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VISION_HOST` | `0.0.0.0` | Host to bind to |
| `VISION_PORT` | `8765` | Port to listen on |

## Model Details

### MiDaS (Depth Estimation)
- Model: `MiDaS_small` (fast, CPU-friendly)
- Output: Relative depth values (0-1, higher = closer)
- Provides depth zones: left, center, right third of image

### YOLOv8 (Object Detection)
- Model: `yolov8n` (nano - fastest)
- Output: Detected objects with labels, confidence, bounding boxes
- Calculates bearing angle assuming 60° horizontal FOV

## Integration with MCP Server

The Node.js MCP server calls this service via HTTP when `observe({mode: "burst"})` is called.
Results populate `WorldState.semantics.detected_objects` and derive place tags.

## Performance

### Inference Speed (after warmup)

| Model | CPU (M1 Mac) | CPU (Intel) | GPU |
|-------|--------------|-------------|-----|
| MiDaS_small | ~100-200ms | ~200-400ms | ~30-50ms |
| YOLOv8n | ~50-100ms | ~100-200ms | ~10-20ms |
| **Combined** | **~150-300ms** | **~300-600ms** | **~40-70ms** |

### Warmup

On startup, the service runs a dummy inference through both models to prime PyTorch's JIT compiler.
This ensures the first real inference is fast.

## First Run

On first run, the models will be downloaded automatically:
- MiDaS: ~100MB from torch hub
- YOLOv8n: ~6MB from Ultralytics

This may take a few minutes on first startup.

## Troubleshooting

### Service won't start
- Check Python version: `python3 --version` (requires 3.8+)
- Ensure venv is activated: `source venv/bin/activate`
- Check port availability: `lsof -i :8765`

### Slow inference
- First inference after startup is slower (JIT compilation)
- Warmup should handle this automatically
- Consider GPU if available: install `torch` with CUDA support

### Memory issues
- MiDaS_small + YOLOv8n require ~1-2GB RAM
- For lower memory, models could be loaded on-demand (not implemented)
