# Roadmap

> For design rationale and architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Priority List

Ordered by impact and dependency:

| # | Task | Why First |
|---|------|-----------|
| 1 | Fix ultrasonic sensor | Blocks all navigation features |
| 2 | Slim Arduino firmware | Clean foundation, add reactive commands |
| 3 | Build server navigation module | Occupancy grid, A*, behaviors |
| 4 | High-level MCP tools | `explore_area()`, `navigate_to()` |
| 5 | Refinement | Performance, reliability, polish |

---

## Current State (v1.0)

### Working
- [x] Basic movement commands (drive, turn, stop)
- [x] Camera capture (still images)
- [x] Servo pan control
- [x] Dead reckoning waypoint navigation
- [x] Command queue for stability
- [x] Auto-reconnection on WiFi drops
- [x] Custom Arduino firmware base (`SmartCarModified/`)
- [x] Makefile build system (`make flash-modified`)
- [x] Consolidated pin definitions (`pins.h`)
- [x] Consolidated constants (`config.h`)

### Known Bugs
See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for details.
- [ ] Ultrasonic returns boolean instead of cm (fix identified)
- [ ] Connection drops intermittently
- [ ] Line sensor async response not fully parsed

---

## Phase 1: Slim Firmware

Strip Arduino firmware down to navigation essentials.

### Remove
- [ ] IRremote library (~50KB)
- [ ] MPU6050 library (~85KB)
- [ ] LED animations & expressions (keep status only)
- [ ] Voice control code
- [ ] Mode button handling
- [ ] Follow mode
- [ ] Rocker (joystick) mode
- [ ] ArduinoJson (use simple parser)

### Keep
- [x] Motor driver (TB6612)
- [x] Ultrasonic sensor (HC-SR04)
- [x] Servo (pan)
- [x] Line sensors (3x IR)
- [x] Serial command interface
- [ ] RGB LED (minimal status indicator only)

### Add
- [ ] Status LED helper (`setStatusLED(color)`)
- [ ] `CMD_DriveUntilObstacle(speed, threshold_cm)`
- [ ] `CMD_ScanArc(start_angle, end_angle, step)`
- [ ] `CMD_FollowWall(side, speed, duration_ms)`
- [ ] `CMD_StartSensorStream(interval_ms)`
- [ ] `CMD_StopSensorStream()`

---

## Phase 2: Server Navigation Module

Build the "brain" in the MCP server.

### Occupancy Grid
- [ ] `OccupancyGrid` class (cell states: unknown/wall/open/visited)
- [ ] Grid update from sensor readings
- [ ] ASCII and JSON export
- [ ] Configurable resolution (cm per cell)

### Pathfinding
- [ ] A* pathfinder implementation
- [ ] Path replanning on obstacle detection
- [ ] Waypoint-to-waypoint navigation

### SQLite Storage
- [ ] `grid_cells` table (x, y, state, confidence)
- [ ] `waypoints` table (name, x, y, heading)
- [ ] `sessions` table (exploration history)
- [ ] `sensor_log` table (optional, for replay/debug)

### Navigation Behaviors
- [ ] Frontier-based exploration
- [ ] Wall following
- [ ] Spiral search pattern

---

## Phase 3: High-Level MCP Tools

Tools Claude uses for strategic commands.

### Core Tools
- [ ] `explore_area(bounds?, max_duration_s?)` → autonomous mapping
- [ ] `navigate_to(target)` → goal-based pathfinding
- [ ] `get_map(format)` → return current occupancy grid
- [ ] `mark_location(name, notes?)` → save waypoint
- [ ] `find_path(from, to)` → plan without executing
- [ ] `list_waypoints()` → return saved locations

### Fix Existing Tools
- [ ] `get_distance()` → return actual cm (not boolean estimate)
- [ ] `get_line_sensors()` → properly parse async response

---

## Phase 4: Refinement

Polish and optimize.

### Performance
- [ ] Sensor streaming mode (continuous updates vs polling)
- [ ] Faster servo scanning
- [ ] Reduce command latency

### Localization
- [ ] Reduce dead reckoning drift
- [ ] Visual landmark support (if camera used)
- [ ] Position confidence tracking

### Reliability
- [ ] Better connection health monitoring
- [ ] Graceful degradation on sensor failure
- [ ] Recovery from stuck states

---

## Future (Nice to Have)

### ESP32 Custom Firmware
Requires USB-to-TTL adapter for flashing.
- [ ] Stable TCP server with proper keep-alive
- [ ] WebSocket support
- [ ] OTA updates

### Computer Vision
- [ ] Object detection (YOLO/MobileNet)
- [ ] Text recognition (OCR)
- [ ] ArUco marker detection for localization

### Multi-Robot
- [ ] Fleet coordination
- [ ] Collision avoidance between robots

### Integrations
- [ ] Home Assistant
- [ ] Voice control

---

## Hardware Wishlist

| Item | Purpose |
|------|---------|
| Wheel encoders | Accurate odometry |
| USB-to-TTL adapter | Flash ESP32 firmware |
| Second ultrasonic (rear) | Safe reversing |
| Compass/IMU | Heading accuracy |

---

## Technical Debt

- [ ] Unit tests for robot client
- [ ] Integration tests with mock robot
- [ ] TypeScript strict mode
- [ ] Better error types
- [ ] Logging configuration
- [ ] Docker container
