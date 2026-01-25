# Roadmap

## Current State (v1.0)

Basic robot control via MCP:
- Movement commands (drive, turn, stop)
- Camera capture (still images)
- Servo pan control
- Simple waypoint navigation (dead reckoning)
- Command queue for stability
- Auto-reconnection on WiFi drops

---

## Phase 1: Stability & Sensors

### Fix Ultrasonic Sensor
- [ ] Investigate Elegoo app traffic to see how it reads distance
- [ ] Try alternative command parameters (D1=2, etc.)
- [ ] Consider adding external ultrasonic sensor via Arduino GPIO if firmware can't be fixed

### Improve Connection Reliability
- [ ] Capture and analyze Elegoo app protocol (Wireshark/packet capture)
- [ ] Test WebSocket vs raw TCP if app uses different transport
- [ ] Identify any initialization/handshake sequence we're missing
- [ ] Add connection health monitoring and preemptive reconnection

### Line Tracking Integration
- [ ] Properly parse async sensor responses
- [ ] Add line-following mode that uses sensor data
- [ ] Create line-tracking patterns/behaviors

---

## Phase 2: Computer Vision & Landmarks

### Local Vision Processing
Run lightweight vision models on the host computer to analyze camera images:

- [ ] **Object Detection**: Identify common objects (chairs, tables, doors, people)
- [ ] **Text Recognition**: Read signs, labels, text in environment
- [ ] **Color/Shape Detection**: Find colored markers or specific shapes
- [ ] **Scene Description**: Generate text metadata about what the camera sees

**Implementation ideas:**
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Robot     │────►│  MCP Server │────►│  Vision     │
│   Camera    │ img │             │ img │  Model      │
└─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           │◄──────────────────┘
                           │   metadata: "red door on left,
                           │              chair ahead 2m,
                           │              sign says EXIT"
```

- Use YOLO, MobileNet, or similar for object detection
- Use Tesseract or EasyOCR for text recognition
- Cache/stream analysis so it's available during navigation

### Visual Landmarks for Position Correction
- [ ] Define landmark types (QR codes, ArUco markers, distinctive objects)
- [ ] Place physical markers in environment at known positions
- [ ] When landmark detected, correct dead reckoning position
- [ ] Build visual map of landmark locations

### Continuous Vision Mode
- [ ] Background thread captures images periodically
- [ ] Maintains rolling buffer of recent visual context
- [ ] Generates text descriptions that Claude can query
- [ ] Alerts on significant changes (new object, obstacle appeared)

---

## Phase 3: Autonomous Behaviors

### Exploration Mode
- [ ] Systematic room exploration using obstacle detection
- [ ] Build occupancy grid map as robot moves
- [ ] Mark explored vs unexplored areas
- [ ] Return to unexplored areas

### Search & Find
- [ ] "Find the red ball" - combines vision + movement
- [ ] Spiral search pattern with visual scanning
- [ ] Report when target found with location

### Patrol Mode
- [ ] Define patrol route via waypoints
- [ ] Continuously loop through waypoints
- [ ] Report anomalies detected during patrol
- [ ] Return to charging station when battery low

---

## Phase 4: Custom Firmware (If USB Programming Solved)

### ESP32 Custom Firmware
If we get USB programming working (external UART adapter):

- [ ] Stable TCP server with proper keep-alive
- [ ] WebSocket support for reliable bidirectional comms
- [ ] Proper ultrasonic distance readings
- [ ] Direct motor PWM control for smoother movement
- [ ] Encoder feedback for accurate odometry
- [ ] OTA update support

### Arduino Firmware Enhancements
The Arduino (Mega/Uno) connected via serial could be modified:

- [ ] Add encoder reading commands
- [ ] Expose raw sensor values
- [ ] Add PID motor control
- [ ] Battery voltage monitoring

---

## Phase 5: Multi-Robot & Integration

### Fleet Control
- [ ] Support multiple robots on same network
- [ ] Coordinate movements to avoid collisions
- [ ] Task distribution across robots

### Home Assistant Integration
- [ ] Expose robot as HA device
- [ ] Trigger movements from automations
- [ ] Security patrol integration

### Voice Control
- [ ] Integrate with voice assistants
- [ ] Natural language movement commands
- [ ] Status reporting via speech

---

## Technical Debt

- [ ] Add unit tests for robot client
- [ ] Add integration tests with mock robot
- [ ] TypeScript strict mode
- [ ] Better error types and handling
- [ ] Logging levels and configuration
- [ ] Configuration file support (not just env vars)
- [ ] Docker container for easy deployment

---

## Hardware Wishlist

Things that would make this project better with hardware additions:

1. **USB-to-TTL adapter** - To flash ESP32 via TX/RX pins
2. **External ultrasonic sensor** - HC-SR04 connected to Arduino GPIO
3. **Wheel encoders** - For accurate odometry
4. **IMU/Compass** - For heading accuracy
5. **Better camera module** - Higher resolution, wider angle
6. **ArUco/QR markers** - For visual landmark system
