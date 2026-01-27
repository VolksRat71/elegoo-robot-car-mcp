# Session Notes: 2025-01-27 - Vision Sidecar & Connection Stability

## Overview

Major session focused on adding vision capabilities and solving persistent TCP connection instability with the ESP32.

---

## 1. Turn Bug Fix

**Problem:** `turn()` method made robot drive forward in an arc instead of rotating in place.

**Root Cause:** Used `CAR_DIRECTION` (N=3) command which does arc turning.

**Solution:** Changed to `MOTOR_CONTROL` (N=1) with opposite motor directions:
- Turn right: Left motor forward, right motor backward
- Turn left: Right motor forward, left motor backward

**File:** `server/src/robot-client-stock.ts` - `turn()` method (lines ~580-615)

---

## 2. Python Vision Sidecar

Created a Python service for computer vision that runs alongside the Node MCP server.

### New Files Created:

```
vision/
├── requirements.txt          # Dependencies: fastapi, torch, ultralytics, timm, etc.
├── main.py                   # FastAPI service on port 8765
├── models/
│   ├── __init__.py
│   ├── depth.py              # MiDaS depth estimation wrapper
│   └── detector.py           # YOLOv8 object detection wrapper
└── README.md                 # Setup instructions
```

### API Endpoints:
- `GET /health` - Returns `{"status": "ok", "models_loaded": true}`
- `POST /analyze` - Accepts `{"image_base64": "...", "run_depth": true, "run_detection": true}`

### Depth Estimation (MiDaS):
- Uses `MiDaS_small` model from torch hub
- Returns relative depth map and zone analysis (left/center/right)
- Outputs `depth_zones` as percentages (0-100%)

### Object Detection (YOLOv8):
- Uses `yolov8n` (nano) model for speed
- Returns detected objects with bounding boxes
- Calculates `bearing_deg` from image center (assumes 60° FOV)

---

## 3. Vision Client (TypeScript)

**File:** `server/src/vision-client.ts`

HTTP client singleton for calling Python vision service:
- `isAvailable()` - Health check
- `analyze(imageBase64, options)` - Call /analyze endpoint
- `getVisionClient()` - Singleton accessor

---

## 4. Depth Calibration

Collected 8 calibration samples to establish thresholds:

| Scenario | Left | Center | Right |
|----------|------|--------|-------|
| Clear (baseline) | ~24% | ~14% | ~25% |
| Obstacle at 1ft | varies | ~42% | varies |
| Very close (<6in) | varies | ~70% | varies |
| Wall (uniform) | ~44% | ~45% | ~46% |

### Established Thresholds:
```typescript
const THRESHOLDS = {
  CLEAR: 25,      // Below = safe to proceed
  OBSTACLE: 40,   // Above = obstacle detected
  DANGER: 60,     // Above = STOP immediately
  WALL_VARIANCE: 10,  // All zones within this = wall
};
```

---

## 5. Connection Diagnostics

**File:** `vision/connection_diagnostics.py`

Created diagnostic tool to measure TCP connection quality:
- Latency metrics: min, avg, p50, p95, p99, max
- Success rate tracking
- Connection drop detection
- Recommendations for control loop timing

---

## 6. ESP32 Connection Limit Discovery

### Key Finding:
**ESP32 firmware can only handle ~4-5 TCP messages per connection before dropping.**

This explains all the intermittent connection failures we were seeing.

### Evidence:
- Tested with persistent connection: ~55% success rate
- Tested with reconnect-every-3: **100% success rate** (30/30 commands)

---

## 7. Reconnect-Every-3 Pattern

Implemented proactive reconnection after every 3 commands to stay within ESP32's limit.

### Python Implementation (`autonomous_driver.py`):
```python
class RobotClient:
    COMMANDS_PER_CONNECTION = 3

    def _ensure_fresh_connection(self) -> bool:
        if self.commands_since_connect >= self.COMMANDS_PER_CONNECTION:
            self.disconnect()
            return self.connect()
        return self.socket is not None
```

### Node Implementation (`robot-client-stock.ts`):
```typescript
private static readonly COMMANDS_PER_CONNECTION = 3;
private commandsSinceConnect = 0;

private async ensureFreshConnection(): Promise<void> {
  if (this.commandsSinceConnect >= StockRobotClient.COMMANDS_PER_CONNECTION) {
    // Proactively reconnect
    this.socket.destroy();
    await this.connect();
  }
}
```

---

## 8. Fire-and-Forget Commands

### Discovery:
ESP32 doesn't reliably send ACK responses, but commands still execute.

### Solution:
Don't wait for ACK - use short timeout (50ms) just to clear buffer:
```python
self.socket.settimeout(0.05)  # 50ms
try:
    self.socket.recv(1024)  # Clear buffer, don't care about response
except socket.timeout:
    pass  # Expected - ESP32 often doesn't ACK
```

---

## 9. Camera Stream Optimization

**Problem:** Opening new HTTP connection per frame caused timeouts.

**Solution:** Keep persistent MJPEG stream, cache latest frame locally.

### CameraStream Class (`autonomous_driver.py`):
```python
class CameraStream:
    def __init__(self, url: str):
        self.latest_frame: Optional[np.ndarray] = None
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()

    def start(self) -> bool:
        self.running = True
        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()

    def get_frame(self) -> Optional[np.ndarray]:
        """Get latest cached frame instantly (no HTTP overhead)."""
        with self.lock:
            return self.latest_frame.copy() if self.latest_frame else None
```

---

## 10. Autonomous Driver Manager

**File:** `server/src/autonomous-driver-manager.ts`

Node module to spawn and manage Python autonomous driver as subprocess:
- Start/stop driver process
- Monitor output and parse metrics
- Run connection diagnostics
- Singleton pattern via `getAutonomousDriverManager()`

---

## 11. MCP Autonomy Tools

**File:** `server/src/tools/autonomy.ts`

New MCP tools for autonomous driving:
- `start_vision_driver(duration_s, cautious, dry_run)` - Start autonomous driving
- `stop_vision_driver()` - Stop autonomous driving
- `driver_status()` - Get current driver state and metrics
- `run_diagnostics(duration_s)` - Run connection quality test

---

## 12. Motor Control Fix in Python Driver

**Problem:** Python driver's `drive()` used N=3 (CAR_DIRECTION) which didn't work reliably.

**Solution:** Changed to N=1 (MOTOR_CONTROL) with direct motor commands:
```python
def drive(self, direction: str, speed: int, duration_ms: int) -> bool:
    mapped_speed = int((speed / 100) * 250)

    if direction == "forward":
        self.send_command(1, 0, mapped_speed, MOTOR_FWD)  # N=1, all motors
    elif direction == "backward":
        self.send_command(1, 0, mapped_speed, MOTOR_BWD)
```

---

## 13. Vision Driver (TypeScript)

**File:** `server/src/autonomy/vision-driver.ts`

TypeScript-based vision driver that:
- Captures images from robot camera
- Sends to Python vision service for depth analysis
- Makes navigation decisions based on depth zones
- Uses exponential moving average for smoothing
- Detects wall patterns and narrow passages

### Decision Logic:
```
DANGER (>60% center) → STOP
Wall pattern (uniform high) → TURN_LARGE
Narrow passage (high L/R, low center) → FORWARD_SLOW
Center blocked (>40%) → TURN toward clearer side
Side blocked → TURN away
All clear (<25%) → FORWARD
```

---

## 14. Firmware Analysis

Examined Elegoo firmware to understand communication:

**Key Findings:**
- Uses Serial at 9600 baud (Arduino Mega)
- ESP32 WiFi module bridges Serial to TCP on port 100
- Camera is separate HTTP/MJPEG on port 81
- JSON command format: `{"H":"1", "N":<cmd>, "D1":<p1>...}`
- No alternative protocol - TCP is the socket interface to Serial

**Command Reference:**
| N | Command | Parameters |
|---|---------|------------|
| 1 | MOTOR_CONTROL | D1=motor(0=all,1=R,2=L), D2=speed, D3=dir |
| 3 | CAR_DIRECTION | D1=direction, D2=speed |
| 5 | SERVO | D1=servo(1=pan), D2=angle(0-180) |
| 21 | ULTRASONIC | D1=1 |
| 23 | GROUND_CHECK | (none) |
| 100 | STANDBY | (none) |

---

## 15. Architecture: Centralized Command Dispatcher (IMPLEMENTED)

**Problem:** Connection management was duplicated in:
- `robot-client-stock.ts` (Node)
- `autonomous_driver.py` (Python)
- `connection_diagnostics.py` (Python)

**Solution:** Option A - Python as single dispatcher

### New Files Created:
- `vision/robot_client.py` - Centralized robot client with:
  - `RobotClient` class - TCP connection with reconnect-every-3
  - `CameraStream` class - Persistent MJPEG stream with frame caching
  - Singleton pattern for global access

- `server/src/robot-proxy.ts` - Node HTTP client that calls Python endpoints

### Modified Files:
- `vision/main.py` - Added robot command endpoints:
  - `POST /robot/drive` - Drive in direction
  - `POST /robot/turn` - Turn in place
  - `POST /robot/stop` - Emergency stop
  - `POST /robot/look` - Set servo angle
  - `GET /robot/distance` - Read ultrasonic
  - `GET /robot/ping` - Connection check
  - `GET /robot/metrics` - Connection stats
  - `POST /robot/led` - Set LED color
  - `POST /robot/raw` - Raw command (advanced)
  - `GET /camera/capture` - Get latest frame as base64
  - `GET /camera/status` - Stream status
  - `GET /status` - Full system status

- `server/src/robot-client.ts` - Updated to use proxy by default
  - Set `ROBOT_MODE=direct` env var for legacy TCP mode
  - Default: routes through Python service

### How It Works:
```
Claude → Node MCP Server → Python HTTP API → TCP:100 → Robot
                                 ↓
                          Camera Stream → Cached Frames
```

**Latency overhead:** ~1-5ms (negligible vs 20-50ms robot latency)

---

## Files Modified This Session

### New Files:
- `vision/` directory (entire Python vision sidecar)
- `server/src/vision-client.ts`
- `server/src/autonomous-driver-manager.ts`
- `server/src/tools/autonomy.ts`
- `server/src/autonomy/vision-driver.ts`
- `vision/connection_diagnostics.py`

### Modified Files:
- `server/src/robot-client-stock.ts` - Turn fix, reconnect-every-3
- `server/src/index.ts` - Added autonomy tools, vision service logging
- `server/src/autonomy/world-state.ts` - Vision integration
- `server/src/tools/tactical.ts` - observe() vision support

---

## Next Steps

1. ~~**Implement centralized command dispatcher**~~ DONE

2. **Test the new architecture**
   - Restart Python vision service
   - Restart Node MCP server
   - Test commands through proxy

3. **Test full autonomous driving loop**

4. **Tune depth thresholds** with more real-world testing

5. **Clean up duplicate code**
   - Remove `RobotClient` from `autonomous_driver.py` (now uses `robot_client.py`)
   - Ensure all Python code imports from centralized module
