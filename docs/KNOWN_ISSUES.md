# Known Issues

> For design decisions and architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Turn Command Goes Forward Instead of Rotating

**Status**: Bug (2026-01-27)

The `turn` tool moves the robot forward instead of rotating in place.

**Expected**: Robot rotates clockwise/counter-clockwise without translating
**Actual**: Robot drives forward

**Files**:
- `server/src/robot-client-stock.ts` → `turn()` method
- Uses `CMD.CAR_DIRECTION` with `DIR.LEFT`/`DIR.RIGHT`

**Notes**: The `drive` command with `direction: "left"` or `"right"` might work differently. Needs investigation of stock Elegoo protocol for in-place rotation vs. arc turning.

---

## HC-SR04 Ultrasonic Sensor Unreliable

**Status**: Hardware limitation - VL53L1X ToF sensor ordered

The stock HC-SR04 ultrasonic sensor gives inconsistent readings:
- Can report 4cm then 100cm for same object position
- Even with 5-sample median filtering, still unreliable
- Not suitable for precise navigation

**Mitigations (2026-01-26):**
- 5-sample median filtering in firmware
- MCP-side smoothing rejects jumps >40cm
- Works OK for obstacle detection (close/far), not precision

**Solution**: VL53L1X Time-of-Flight sensor ordered
- Uses I2C (A4/A5 pins now available after MPU6050 removal)
- Much more accurate (mm precision)
- Will require firmware driver update

**Files**:
- `firmware/arduino/SmartCarModified/DeviceDriverSet_xxx0.cpp`
- `server/src/robot-client-stock.ts` → `getDistance()`

---

## Connection Drops

**Status**: Improved (2026-01-26)

TCP connection to robot (port 100) drops intermittently.

**Mitigations:**
- Command queue serializes requests
- Commands wait for reconnection (up to 5s) instead of failing
- Immediate reconnection attempt, then every 2s
- Socket close event guarded against spurious triggers
- 10s heartbeat interval
- Emergency stop bypasses queue

**Files**: `server/src/robot-client-stock.ts`

---

## Line Sensors Async Response

**Status**: Partial implementation

Line tracking command (N=22) returns data asynchronously. Current code doesn't properly wait for/parse the response.

**Files**:
- `server/src/robot-client-stock.ts` → `getLineSensors()`
- `server/src/tools/sensors.ts`

---

## ESP32 USB-C is Power Only

**Status**: Hardware limitation

The ESP32-S3 board's USB-C port doesn't expose data lines. Cannot flash custom firmware via USB.

**Workaround**: Use USB-to-TTL adapter on TX/RX pins (not yet attempted).

---

---

## Test Results (2026-01-27)

All 16 MCP tools tested via Claude Code:

| Tool | Status | Notes |
|------|--------|-------|
| `get_status` | ✅ Pass | Connection, mode, position |
| `get_position` | ✅ Pass | Quick position check |
| `reset_position` | ✅ Pass | Reset to origin |
| `get_distance` | ✅ Pass | 100cm reading (fallback mode) |
| `capture_image` | ✅ Pass | JPEG returned, LLM can see it |
| `look` | ✅ Pass | Pan 45°, 90°, 135° |
| `drive` | ✅ Pass | Forward/backward with duration |
| `turn` | ⚠️ Bug | Goes forward instead of rotating |
| `save_waypoint` | ✅ Pass | Saved waypoint |
| `list_waypoints` | ✅ Pass | Listed waypoints |
| `delete_waypoint` | ✅ Pass | Deleted waypoint |
| `clear_map` | ✅ Pass | Reset map data |
| `execute_sequence` | ✅ Pass | Turn + drive + capture |
| `explore` | ✅ Pass | 5s autonomous, 24cm traveled |
| `stop` | ✅ Pass | Halted, state → IDLE |
| `observe` | ✅ Pass | Full WorldState returned |

---

## Resolved Issues

### Ultrasonic Returns Boolean, Not Distance

**Status**: Fixed (2026-01-26)

Was sending D1=1 (boolean), now sends D1=2 (numeric cm). Falls back to D1=1 if firmware doesn't support D1=2.

### Build: FastLED Version Sensitivity

**Status**: Resolved

FastLED 3.10.x causes firmware to exceed flash limit. Using FastLED 3.4.0 with Arduino Uno target (32KB flash).

### Firmware Size

**Status**: Resolved (2026-01-26)

Firmware reduced from 31KB (96%) to 21KB (65%) by removing IR remote, MPU6050, Follow mode, Rocker mode, and complex LED patterns.
