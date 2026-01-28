# Session Notes: 2025-01-28

## Summary

Implemented external reviewer feedback for autonomous driver fixes, then refactored vision architecture for background processing and resource management.

---

## Part 1: Autonomous Driver Fixes (from LLM Review)

Applied 7 fixes based on external analysis of decision-making bugs:

### 1. Circle Detection Threshold Fix
**File:** `vision/autonomous_driver.py`
- Changed `should_force_opposite()` to use `obstacle_threshold` (50%) instead of `danger_threshold` (70%)
- Prevents forcing turns into blocked sides (e34 bug where robot turned into 66% blocked area)

### 2. Record Turn Ordering
**File:** `vision/autonomous_driver.py`
- Moved `record_turn()` call to AFTER all overrides
- `recent_turns` now reflects actual executed decisions, not initial candidates
- Fixes circle detection fighting against legitimate obstacle avoidance

### 3. Wall Handler Action Phase
**File:** `vision/autonomous_driver.py`
- Removed direct `robot.drive()` call from wall handler
- Now uses commitment FSM: sets `wall_escape_turn`, commits to REVERSE, FSM handles transition
- Eliminates dual motor command issues (red LED flashing)

### 4. Commitment Breaks on Obstacle
**File:** `vision/autonomous_driver.py`
- Commitment FSM now breaks on `obstacle_threshold` during forward motion, not just `danger_threshold`
- Prevents robot pushing into obstacles during 1.2s forward commitment

### 5. Corner Detector with Escalation
**File:** `vision/autonomous_driver.py`
- Added `is_corner_pattern()` - detects L+R blocked, C not clear
- Escalating escape: 600ms → 900ms → 1200ms reverse on repeated corners within 5s
- Uses LARGE turns for corners

### 6. Circle Detection as Soft Bias
**File:** `vision/autonomous_driver.py`
- Changed from hard override to tie-breaker bias
- Only applies when BOTH sides safe (<50%) AND similar (<15% difference)
- Logs when circle-breaking is skipped due to blocked side

### 7. Decision Tracing
**File:** `vision/autonomous_driver.py`
- Logs decision chain when overrides occur: `[TRACE] base:X → wall:Y → final:Z`
- Makes debugging unexpected decisions much faster

---

## Part 2: Background Vision Processor

### Problem
- Vision processing (MiDaS depth) ran synchronously in decision loop
- Caused 200-300ms blocking per decision
- UI only updated every 200ms

### Solution: Decoupled Architecture

**File:** `vision/main.py`

Added `VisionProcessor` class:
- Background thread runs depth estimation continuously
- Caches latest results for instant access
- Decision loop and UI sample cached results (no blocking)

New endpoints:
- `GET /vision/latest` - cached depth zones (instant)
- `GET /vision/latest/frame` - cached frames + depth overlay
- `GET /vision/latest/full` - everything combined
- `GET /vision/stats` - processor statistics
- `POST /vision/detection` - toggle YOLO on/off

### Architecture
```
[Camera] → [VisionProcessor Thread] → [Cache]
                                         ↓
                    ┌────────────────────┼────────────────────┐
                    ↓                    ↓                    ↓
             [Decision Loop]         [UI/API]          [Montage]
              samples @5Hz          polls @30Hz
```

---

## Part 3: Adaptive Frame Rate

### Problem
- Fixed 10fps was either too slow (powerful hardware) or too fast (CPU hogging)

### Solution
**File:** `vision/main.py`

- Target 30fps, drop frames if processing can't keep up
- Tracks actual FPS and dropped frame count
- Graceful degradation on slower hardware

Stats now include:
- `actual_fps` - what we're achieving
- `frames_dropped` - how many we couldn't process in time

---

## Part 4: Resource Configuration

### Problem
- MiDaS running at high FPS was CPU-intensive
- No way to tune for different hardware

### Solution

**File:** `vision/models/depth.py`
- Added thread limiting: `torch.set_num_threads()`
- Auto-detects best device: CUDA → MPS (Mac) → CPU

**File:** `vision/vision-service-manager.ts`
- Passes resource config to Python sidecar

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_THREADS` | `2` | CPU threads for PyTorch |
| `VISION_FPS` | `30` | Target FPS (drops frames if needed) |
| `VISION_DEVICE` | `auto` | Force: `cpu`, `cuda`, `mps`, or `auto` |

---

## Part 5: Dashboard Auto-Start

### Problem
- MCP server started Python sidecar but not dashboard
- User had to manually run `npm run dev` in dashboard/

### Solution

**File:** `server/src/dashboard-manager.ts` (NEW)
- Similar pattern to `VisionServiceManager`
- Spawns `npm run dev` in dashboard directory
- Manages lifecycle, cleanup on shutdown

**File:** `server/src/index.ts`
- Added dashboard startup alongside vision service
- Both start non-blocking, MCP available immediately

---

## Part 6: Camera Polling Fallback

### Problem
- MJPEG stream on port 81 sometimes fails (connection reset)
- Single capture on port 80 always works

### Solution

**File:** `vision/robot_client.py`

`CameraStream` now has dual modes:
1. **Stream mode** (primary) - MJPEG from port 81
2. **Polling mode** (fallback) - individual captures from port 80

After 3 stream failures, automatically switches to polling mode.

---

## Files Modified

| File | Changes |
|------|---------|
| `vision/autonomous_driver.py` | 7 decision fixes, decision tracing, vision integration |
| `vision/main.py` | VisionProcessor, adaptive FPS, new endpoints |
| `vision/models/depth.py` | Thread limiting, MPS support, device config |
| `vision/robot_client.py` | Camera polling fallback |
| `server/src/index.ts` | Dashboard auto-start |
| `server/src/vision-service-manager.ts` | Resource config passthrough |
| `server/src/dashboard-manager.ts` | NEW - dashboard lifecycle manager |

---

## Testing Notes

To tune for your machine:
```bash
# Light load
VISION_THREADS=2 VISION_FPS=15

# Heavy but smooth
VISION_THREADS=4 VISION_FPS=30

# Check actual performance
curl http://localhost:8765/vision/stats
```

---

## Next Steps

- Test adaptive frame rate under load
- Consider SSE stream for real-time UI updates
- Add semantic object integration (look_for/avoid using YOLO)
- Implement visit tracker persistence across sessions
