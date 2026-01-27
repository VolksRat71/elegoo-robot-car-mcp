# Roadmap

> For design rationale and layer contracts, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Current State

### Completed (2026-01-26)

- [x] Firmware slimmed: 31KB → 21KB (65%)
- [x] Removed: IR remote, MPU6050, Follow mode, Rocker mode, complex LEDs
- [x] Ultrasonic: 5-sample median filtering in firmware
- [x] Ultrasonic: MCP-side smoothing for jumps >40cm
- [x] Connection stability: Commands wait for reconnection
- [x] Connection stability: Immediate reconnect, then 2s interval
- [x] Status LED simplified (green/yellow/orange/blue/red blink)
- [x] I2C pins freed (A4/A5) for VL53L1X

### Known Issues

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for details.

- **HC-SR04 ultrasonic unreliable** — VL53L1X ordered as replacement
- **Connection drops** — Improved but not eliminated
- **Line sensors async response** — Partial implementation

---

## Phase 1: Stable Reactive Substrate — IN PROGRESS

**Goal:** A trustworthy physical layer that won't crash regardless of host behavior.

| Task | Status | Notes |
|------|--------|-------|
| Slim firmware | Done | 21KB (65%) |
| Ultrasonic filtering | Done | 5-sample median |
| Connection stability | Done | Wait-for-reconnect |
| **VL53L1X ToF driver** | Waiting | Hardware ordered |
| Safety envelope | Blocked | Needs ToF for reliable distance |
| Watchdog timeout | Blocked | After ToF integration |

**Next steps when VL53L1X arrives:**
1. Wire to A4 (SDA), A5 (SCL), 3.3V, GND
2. Add Pololu VL53L1X library to firmware
3. Replace `DeviceDriverSet_ULTRASONIC` with ToF calls
4. Add safety envelope (hard stop < 10cm, slow < 25cm)
5. Add watchdog (stop if no command for 300-500ms)

---

## Phase 2: Host as Tactical Brain

**Goal:** Host handles all real-time decisions. LLM can pause without affecting motion.

| Task | Status | Depends On |
|------|--------|------------|
| Time-bounded motion primitives | Not started | Phase 1 |
| Gap following from scan bins | Not started | ToF scans |
| Automatic recovery behaviors | Not started | — |
| Speed limiting near obstacles | Not started | ToF |
| Action timeouts | Not started | — |

**Key deliverable:** `SET_TWIST(v_mm_s, w_deg_s, duration_ms)` command that executes locally with safety enforcement.

---

## Phase 3: Place Graph Mapping

**Goal:** Map that's useful for LLM reasoning, not just geometry.

| Task | Status | Depends On |
|------|--------|------------|
| Place node creation | Not started | ToF scans |
| Edge creation between places | Not started | Odometry or timing |
| Loop closure detection | Not started | Place signatures |
| SQLite persistence | Not started | — |
| Semantic labeling (vision) | Not started | Camera integration |

**Key insight:** Topological map (place graph) is more robust to drift and easier for LLMs to reason about than pure occupancy grids.

---

## Phase 4: Full MCP Interface

**Goal:** LLM uses high-level intent tools, not motor commands.

| Tool | Status | Description |
|------|--------|-------------|
| `explore()` | Not started | Autonomous frontier exploration |
| `goto(place_id)` | Not started | Place-to-place navigation |
| `observe()` | Not started | Structured environment summary |
| `list_places()` | Not started | Get known locations |
| `describe_place()` | Not started | Details about a place |
| `set_constraints()` | Not started | Speed limits, no-go zones |

**Current tools to deprecate (hide from LLM):**
- `drive()` — too low-level
- `get_distance()` — raw sensor data

---

## Phase 5: Experience & Learning

**Goal:** Robot gets better at roaming over time.

| Task | Status |
|------|--------|
| Track edge success/failure rates | Not started |
| Track place visit frequency | Not started |
| Prefer unexplored frontiers | Not started |
| Avoid problematic areas | Not started |
| Summarize experience for LLM | Not started |

---

## Phase 6: Encoders

**Goal:** Improve reliability without changing MCP contract.

| Task | Status | Notes |
|------|--------|-------|
| Select encoder hardware | Not started | Hall effect or optical |
| Closed-loop speed control | Not started | — |
| Odometry (x, y, θ) | Not started | With uncertainty |

**Important:** This phase improves accuracy but doesn't change how LLM interacts with robot.

---

## Hardware Priority Queue

| Item | Purpose | Status |
|------|---------|--------|
| VL53L1X ToF | Reliable distance sensing | **Ordered** |
| Wheel encoders | Odometry | Planning |
| Rear ToF | Safe reversing | Future |
| Camera improvements | Visual place recognition | Future |

---

## Technical Debt

- [ ] Unit tests for robot client
- [ ] Integration tests with mock robot
- [ ] TypeScript strict mode
- [ ] Better error types
- [ ] Logging configuration

---

## Future Ideas (Unprioritized)

- ESP32 custom firmware (needs USB-TTL adapter)
- Object detection with camera
- ArUco markers for localization
- Home Assistant integration
- Multi-robot coordination
