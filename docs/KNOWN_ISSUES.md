# Known Issues

> For design decisions and architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Connection Drops

**Status**: Partially mitigated

TCP connection to robot (port 100) drops intermittently:
- After idle periods
- During rapid command sequences
- Sometimes mid-sequence

**Mitigations (2025-01-25):**
- Command queue serializes requests (one in-flight at a time)
- Auto-reconnection on socket errors
- 10s heartbeat interval
- Emergency stop bypasses queue

**Files**: `server/src/robot-client-stock.ts`

**Next steps**: Sniff Elegoo app traffic to find protocol differences

---

## Ultrasonic Returns Boolean, Not Distance

**Status**: Fix identified, not implemented

The `get_distance()` tool returns estimated values (15cm or 100cm) instead of actual readings.

**Root cause**: MCP sends D1=1 (boolean mode) instead of D1=2 (distance mode).

**Fix**:
1. Change `getDistance()` to send `{N:21, D1:2}`
2. Parse numeric response `{1_XXX}` where XXX = cm
3. Firmware caps at 150cm max

**Files**:
- `server/src/robot-client-stock.ts` → `getDistance()`
- `server/src/tools/sensors.ts`

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

## Build: FastLED Version Sensitivity

**Status**: Resolved

FastLED 3.10.x causes firmware to exceed flash limit. Using FastLED 3.4.0 works.

**Fix**: Makefile uses Arduino Uno target (32KB flash) instead of Nano (30KB).
