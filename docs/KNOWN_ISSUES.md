# Known Issues

## Connection Stability

### WiFi/TCP Connection Drops
**Status**: Partially mitigated, not fully solved

The TCP connection to the robot (port 100) drops intermittently, especially:
- After idle periods
- During rapid command sequences
- Sometimes mid-sequence

**Mitigations implemented (2025-01-25):**
- Command queue to serialize all robot commands (one in-flight at a time)
- Improved socket error handling with automatic reconnection
- Heartbeat interval increased from 3s to 10s to reduce interference
- Sequences abort gracefully on connection loss
- Emergency stop bypasses queue and clears pending commands

**Root cause:**
The ESP32-S3 module running Elegoo's stock firmware handles the WiFi/TCP server. We cannot modify this firmware (see ESP32 Firmware section below). The Elegoo mobile app appears to work more reliably, suggesting there may be protocol nuances we're missing.

**Potential investigations:**
- Sniff traffic from Elegoo app to see if they use different protocol/timing
- Check if WebSocket vs raw TCP makes a difference
- Investigate if there's a specific keep-alive or handshake sequence

---

## Ultrasonic Sensor

### Distance Readings Always Return 0 or Boolean
**Status**: Unresolved

The ultrasonic sensor (N=21 command) does not return actual distance values in centimeters. Instead:
- With D1=1: Returns `{1_true}` or `{1_false}` for obstacle detection
- With D1=2: Should return distance but returns `{1_0}` or similar

**Workaround:**
The `get_distance` tool returns estimated values based on boolean obstacle detection:
- `true` (obstacle detected) → reports 15cm
- `false` (clear) → reports 100cm

**Possible causes:**
- Firmware bug in stock Elegoo firmware
- Different sensor model than expected
- Command parameters incorrect

**Files affected:**
- `server/src/robot-client-stock.ts` - `getDistance()`, `hasObstacle()`
- `server/src/tools/sensors.ts`

---

## ESP32 Firmware

### Cannot Flash Custom Firmware via USB-C
**Status**: Blocked

The ESP32-S3-WROOM-1 on the ESP32S3-Camera-V1.0 board has a USB-C port, but:
- Does not appear as a USB device when connected to computer
- Tried bootloader mode (BOOT + RESET sequence)
- Installed CH340 driver (not needed for ESP32-S3 native USB)
- The USB-C port appears to be **power-only**, not connected to USB data lines

**Hardware details:**
- Chip: ESP32-S3-WROOM-1 (Espressif)
- Board: ESP32S3-Camera-V1.0
- The ESP32-S3 has native USB support, so no external UART chip needed IF the USB lines were connected

**Alternatives to explore:**
1. Use a USB-to-TTL adapter (FTDI, CP2102) connected to TX/RX pins on the board
2. Check if Elegoo sells a programming dock
3. Find alternative ESP32-CAM board with working USB programming

**Why this matters:**
Custom ESP32 firmware would let us:
- Fix connection stability at the source
- Add WebSocket support for more reliable connections
- Get proper ultrasonic distance readings
- Add more features without Arduino modification

---

## Line Tracking Sensors

### Async Response Not Fully Integrated
**Status**: Partial implementation

The line tracking sensors (N=22 command) return data asynchronously. Current implementation sends the command but doesn't properly wait for/parse the response.

**Files affected:**
- `server/src/robot-client-stock.ts` - `getLineSensors()`
- `server/src/tools/sensors.ts`

---

## Position Tracking

### Dead Reckoning Drift
**Status**: Expected behavior, needs improvement

Position estimation uses dead reckoning based on:
- Movement direction and duration
- Assumed speed
- Turn angles

This accumulates error over time. The robot's actual position will drift from estimated position, especially after:
- Multiple turns
- Wheel slippage
- Obstacle collisions

**Future solutions:**
- Visual landmark recognition for position correction
- Use camera to identify known objects/locations
- Implement SLAM-lite with obstacle map

---

## Camera

### No Video Streaming
**Status**: By design (current implementation)

Camera only captures still images via HTTP GET to `/capture`. Video streaming would require:
- MJPEG stream parsing
- Higher bandwidth handling
- Different MCP tool design (streaming vs request/response)

The stock firmware does support MJPEG streaming (used by Elegoo app), but implementing this in MCP is non-trivial.
