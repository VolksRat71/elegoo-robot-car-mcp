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

### Future: Line Sensors for Edge Detection

The IR line-tracking sensors (left, center, right) are currently disabled but should be repurposed for **edge detection** (table/cliff detection). When robot approaches an edge:
- Floor reflects IR → sensor reads LOW
- No floor (edge/cliff) → sensor reads HIGH

This provides a safety feature to prevent the robot from driving off tables or stairs. Implementation should:
1. Read line sensors before forward movement
2. If any sensor reads HIGH (no floor), trigger emergency stop
3. Integrate with safety envelope in autonomy layer

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
| WorldState schema v1 | **Done** | Schema locked, buildWorldState() implemented |
| WorldState logging | **Done** | SQLite sessions + JSONL replay export |

**Next steps when VL53L1X arrives:**
1. Wire to A4 (SDA), A5 (SCL), 3.3V, GND
2. Add Pololu VL53L1X library to firmware
3. Replace `DeviceDriverSet_ULTRASONIC` with ToF calls
4. Add safety envelope (hard stop < 10cm, slow < 25cm)
5. Add watchdog (stop if no command for 300-500ms)
6. Implement WorldState schema v1 in TypeScript
7. Add SQLite logging for replay

---

## Phase 2: Host as Tactical Brain + MCP Contract

**Goal:** Host handles all real-time decisions. Lock MCP tool contract early (even if behavior is primitive).

| Task | Status | Depends On |
|------|--------|------------|
| Time-bounded motion primitives | **Done** | drive() with duration_ms |
| Local costmap (~2m x 2m) | Not started | ToF scans |
| Host autonomy state machine | **Done** | IDLE/EXECUTING/STUCK implemented |
| Gap following from scan bins | Blocked | ToF sensor |
| Automatic recovery behaviors | Partial | Basic turn-on-obstacle |
| Speed limiting near obstacles | Blocked | ToF sensor |
| Action timeouts | Not started | — |
| **MCP tools stubbed** | **Done** | 16 tools consolidated from 24 |

**Key insight:** Stub `explore()`, `goto()`, `observe()` early with simple behavior. The LLM starts using the real API immediately; autonomy improves behind it.

### MCP Tools — Current (16 tools)

**Movement (2):** `drive`, `turn`
**Sensors (1):** `get_distance`
**Vision (2):** `capture_image`, `look`
**Navigation (2):** `save_waypoint`, `list_waypoints`
**System (5):** `get_status`, `get_position`, `reset_position`, `clear_map`, `delete_waypoint`
**Sequences (1):** `execute_sequence`
**Tactical (3):** `observe`, `explore`, `stop`

### Gated Tools (Disabled until VL53L1X)

| Tool | Reason |
|------|--------|
| `scan_surroundings` | Ultrasonic too noisy for mapping |
| `navigate_to` | Dead reckoning unreliable without ToF |
| `list_places` | Place graph needs ToF fingerprints |

### Removed Tools

| Tool | Reason |
|------|--------|
| `safe_drive` | Merged into `drive(check_obstacle=true)` |
| `emergency_stop` | Replaced by `stop()` with state machine |
| `execute_pattern` | Redundant (use `execute_sequence`) |
| `set_mode` | Stock firmware doesn't support autonomous modes |
| `get_line_sensors` | Repurpose for edge detection (see Future section) |

---

## Phase 3: Place Graph Mapping

**Goal:** Map that's useful for LLM reasoning, not just geometry.

| Task | Status | Depends On |
|------|--------|------------|
| Place node creation | Not started | ToF fingerprints |
| Edge creation between places | Not started | Movement tracking |
| Loop closure detection | Not started | Place signatures |
| Loop closure confidence scoring | Not started | Multiple matching signals |
| SQLite persistence (places + edges) | Not started | Phase 1 schema |
| Semantic labeling (vision) | Not started | Camera integration |

**Key insight:** Place Graph is the LLM-facing map. Local costmap (from Phase 2) is internal.

---

## Phase 4: Experience & Learning

**Goal:** Robot gets better at roaming over time.

| Task | Status |
|------|--------|
| Track edge success/failure rates | Not started |
| Track place visit frequency | Not started |
| Prefer unexplored frontiers | Not started |
| Avoid problematic areas | Not started |
| Summarize experience for LLM | Not started |

---

## Phase 5: Encoders

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

## Host Autonomy State Machine (Target)

```
IDLE → EXECUTING → AVOIDING → RECOVERING → RELOCALIZING → STUCK
```

See [ARCHITECTURE.md](./ARCHITECTURE.md#host-autonomy-state-machine) for full diagram and transitions.

---

## Debug Tools (Gated)

These remain available behind a "debug mode" flag, not exposed to LLM by default:

| Tool | Purpose |
|------|---------|
| `move(v, w, duration)` | Direct motion (time-bounded, safety-enforced) |
| `get_raw_telemetry()` | Raw sensor dump |

---

## Technical Debt

- [ ] Unit tests for robot client
- [ ] Integration tests with mock robot
- [ ] TypeScript strict mode
- [ ] Better error types
- [ ] Logging configuration
- [ ] Replay tooling (playback from JSONL)

---

## Future Ideas (Unprioritized)

- ESP32 custom firmware (needs USB-TTL adapter)
- Object detection with camera
- ArUco markers for localization
- Home Assistant integration
- Multi-robot coordination
- Voice control via LLM
