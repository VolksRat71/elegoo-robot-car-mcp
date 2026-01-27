# Architecture: LLM-First Robot MCP

## Primary Goal

> **Build a Robot MCP (Model Context Protocol) that allows LLMs to safely, reliably, and progressively roam the physical world.**

The key principle:
- The **LLM is strategic**, not tactical
- The **host is the autonomy & memory layer**
- The **microcontroller enforces safety and timing**, regardless of LLM behavior

---

## Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        STRATEGIC LAYER (LLM)                            │
│  Intent, goals, policies, reasoning                                     │
│  "explore the room" / "find something red" / "patrol between A and B"   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          MCP Protocol (tools)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TACTICAL LAYER (Host)                            │
│  MCP Server + Robot Autonomy Runtime                                    │
│  Sensor fusion, mapping, path selection, memory, behavior execution     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                         Serial/TCP (fast loop)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        REACTIVE LAYER (Arduino)                         │
│  Motor PWM, sensor reads, servo control, safety envelope, watchdog      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer Contracts

### Reactive Layer — Arduino Uno

**Never exposed directly to the LLM.**

| Responsibility | Description |
|----------------|-------------|
| Motor control | PWM timing, direction, differential drive |
| Sensor reads | ToF/ultrasonic distance, line sensors |
| Servo control | Pan angle for sensor head |
| Safety envelope | Hard stop if obstacle < D_stop, slow if < D_slow |
| Watchdog | Stop motors if host silent for 300-500ms |

**Guarantee:**
> The robot will not crash or behave dangerously, even if higher layers stall or misbehave.

**Output to Host:**
- `distance_mm` (10-20 Hz continuous or on-demand)
- `scan_bins_mm` (1-2 Hz, binned servo sweep)
- Events: `obstacle_abort`, `watchdog_stop`, `low_battery`

---

### Tactical Layer — Host (MCP Server)

**The MCP implementation lives here. Handles everything between intent and motors.**

| Responsibility | Description |
|----------------|-------------|
| Sensor fusion | Combine ToF, encoders (future), vision metadata |
| Mapping | Place graph or occupancy grid |
| Localization | Position estimation with uncertainty |
| Path selection | A*, frontier exploration, recovery behaviors |
| Memory | Experience accumulation, place visit history |
| Behavior execution | Translate high-level intent into motion primitives |

**Guarantee:**
> The LLM never has to reason about PWM, jitter, sensor noise, or timing.

**Commands to Arduino:**
- `SET_TWIST(v_mm_s, w_deg_s, duration_ms)` — time-bounded motion
- `STOP()` — immediate halt
- `SCAN(start_angle, end_angle, step)` — servo sweep

**Outputs to LLM:**
- Structured summaries (not raw streams)
- Place descriptions and semantic labels
- Confidence levels for localization and safety

---

### Strategic Layer — LLM

**Intent, goals, policies, reasoning. Never touches motors.**

| Responsibility | Description |
|----------------|-------------|
| Goal selection | "explore", "patrol", "return home", "find X" |
| Constraints | "avoid people", "be quiet", "stay in this room" |
| Information requests | "I need more detail about that area" |
| Long-horizon planning | Multi-step task decomposition |
| Interpretation | Understanding summaries and making decisions |

**Guarantee:**
> The LLM reasons in symbols, places, and intent — not motors, timing, or signals.

**What the LLM should NOT do:**
- Issue individual motor commands
- Parse raw sensor data
- Handle obstacle avoidance logic
- Manage connection stability
- Worry about timing or jitter

---

## MCP Interface Design

### Actions (LLM → Host)

**Movement:**
```
explore(duration_s | frontier_id)  → Autonomous exploration
goto(place_id)                     → Navigate to known place
stop()                             → Halt current action
```

**Sensing:**
```
observe(mode="quick" | "burst")    → Get current surroundings
scan()                             → Request fresh sensor sweep
```

**Memory:**
```
list_places()                      → Get known locations
describe_place(place_id)           → Details about a place
set_home(place_id)                 → Mark home location
return_home()                      → Navigate back to home
```

**Constraints:**
```
set_constraints({
  max_speed,
  min_person_distance,
  no_go_places,
  quiet_mode
})
```

### Observations (Host → LLM)

Structured summaries, not raw streams:

```typescript
{
  robot_state: {
    mode: "exploring" | "navigating" | "idle" | "stuck",
    last_action: string,
    stuck_counter: number
  },
  geometry: {
    front_min_mm: number,
    scan_bins_mm: number[],
    best_gap: { bearing: number, width_mm: number }
  },
  semantics: {
    detected_objects: { label: string, bearing: number, confidence: number }[],
    current_place_tags: string[]  // "hallway", "open_area", "cluttered"
  },
  map_summary: {
    current_place: string,
    nearby_places: string[],
    unexplored_frontiers: number
  },
  confidence: {
    localization: number,  // 0-1
    safety: number         // 0-1
  }
}
```

LLM can request richer data explicitly with `observe(mode="burst")`.

---

## Mapping Approach: Place Graph

Instead of pure geometric SLAM (which drifts and is hard for LLMs to reason about), use a **topological Place Graph**:

```
    [hallway_1] ──── [living_room] ──── [kitchen]
         │                │
    [bedroom_1]      [front_door]
```

### Place Node Structure

```typescript
interface Place {
  id: string;
  signature: {
    tof_fingerprint: number[];    // Binned scan at this location
    camera_stills: string[];      // 3-5 reference images
    semantic_labels: string[];    // "couch", "doorway", "window"
  };
  tags: string[];                 // "open_area", "narrow", "cluttered"
  visit_count: number;
  last_visited: Date;
  typical_obstacles: string[];
}
```

### Edge Structure

```typescript
interface Edge {
  from: string;
  to: string;
  action: string;               // "forward_2m", "turn_left_90"
  success_rate: number;         // 0-1, learned over time
  typical_duration_ms: number;
}
```

### Loop Closure ("Have I been here?")

Probabilistic matching using:
1. ToF scan similarity (primary)
2. Visual similarity (confirmation)
3. Semantic consistency

This approach:
- Is robust to odometry drift
- Provides stable symbols for LLM reasoning
- Naturally accumulates experience

---

## Experience & Memory

The host accumulates experience that improves roaming over time:

| Data | Purpose |
|------|---------|
| Place visit counts | Prefer unexplored areas |
| Edge success/failure rates | Avoid unreliable paths |
| Object density by place | Inform expectations |
| Typical obstacles | Predict problems |
| Recovery frequency | Identify trouble spots |

**Result:** Fewer repeated dead ends, smarter exploration, context-aware navigation — without LLM micromanagement.

---

## Hardware Layers

### Current Setup

| Component | Pin(s) | Status |
|-----------|--------|--------|
| TB6612 motor driver | D3, D5-D8 | Working |
| HC-SR04 ultrasonic | D12, D13 | Unreliable (see Known Issues) |
| SG90 servo (pan) | D10 | Working |
| 3x line sensors | A0-A2 | Working |
| RGB LED (status) | D4 | Simplified |
| Battery voltage | A3 | Working |
| I2C (available) | A4, A5 | Ready for VL53L1X |

### Planned Upgrades

| Component | Purpose | Priority |
|-----------|---------|----------|
| VL53L1X ToF | Reliable distance (mm precision) | **Ordered** |
| Wheel encoders | Closed-loop odometry | High |
| Rear ToF | Safe reversing | Medium |
| Camera integration | Visual place recognition | Medium |

---

## Arduino Firmware: Slimmed

The firmware has been reduced from 31KB (96%) to 21KB (65%) by removing unused features.

### Removed
- IR remote control
- MPU6050 gyroscope
- Follow mode
- Rocker/joystick mode
- Complex LED patterns
- Key command handler

### Kept
- Motor control (differential drive)
- Ultrasonic sensor (5-sample median filtering)
- Servo control
- Line tracking mode
- Obstacle avoidance mode
- Simple status LED

### Status LED Colors

| Color | Meaning |
|-------|---------|
| Green | Standby (ready) |
| Yellow | Line tracking mode |
| Orange | Obstacle avoidance mode |
| Blue | Active/other modes |
| Red blink | Low battery warning |

### Future Firmware Additions

Once VL53L1X arrives:
- ToF driver (I2C on A4/A5)
- Watchdog timer (stop if host silent 300-500ms)
- Time-bounded motion primitives
- Safety envelope enforcement

---

## Implementation Phases

### Phase 1: Stable Reactive Substrate — IN PROGRESS

**Objective:** Create a trustworthy physical layer that higher layers can rely on.

- [x] Slim firmware (removed ~10KB)
- [x] Ultrasonic median filtering
- [x] Connection stability improvements
- [ ] VL53L1X ToF integration (hardware ordered)
- [ ] Safety envelope (hard stop < D_stop)
- [ ] Watchdog timeout (300-500ms)

**Success criteria:** No collisions, smooth motion under WiFi jitter, deterministic behavior.

---

### Phase 2: Host as Tactical Brain

**Objective:** Decouple LLM reasoning time from control timing.

- [ ] Time-bounded motion primitives (`SET_TWIST`)
- [ ] Host-side gap following from scan bins
- [ ] Automatic recovery (backup → turn → rescan)
- [ ] Speed limiting near obstacles
- [ ] Action timeouts

**Success criteria:** LLM can pause/think without affecting motion. Host handles all "robot reflexes."

---

### Phase 3: Place Graph Mapping

**Objective:** Build a map useful for reasoning, not just geometry.

- [ ] Place node creation from sensor signatures
- [ ] Edge creation when moving between places
- [ ] Loop closure detection
- [ ] SQLite storage for persistence
- [ ] Semantic labeling (with vision, optional)

**Success criteria:** Robot can recognize "I've been here before" and navigate between named places.

---

### Phase 4: Full MCP Interface

**Objective:** Expose high-level tools to the LLM.

- [ ] `explore()` — autonomous frontier exploration
- [ ] `goto(place_id)` — place-to-place navigation
- [ ] `observe()` — structured environment summary
- [ ] `list_places()` / `describe_place()`
- [ ] `set_constraints()`
- [ ] Deprecate/hide low-level tools from LLM

**Success criteria:** LLM can command "explore the room" and receive meaningful results without micromanaging.

---

### Phase 5: Experience & Learning

**Objective:** Roaming improves over time.

- [ ] Track edge success/failure rates
- [ ] Track place visit frequency
- [ ] Prefer unexplored frontiers
- [ ] Avoid historically problematic areas
- [ ] Summarize experience for LLM context

**Success criteria:** Second exploration of same space is faster and more efficient than first.

---

### Phase 6: Encoders (Reliability Improvement)

**Objective:** Improve navigation accuracy without changing MCP contract.

- [ ] Closed-loop speed control
- [ ] Odometry (x, y, θ) with uncertainty
- [ ] Better loop closure confidence

**Important:** Encoders make roaming more reliable but do not change how the LLM interacts with the robot.

---

## Guiding Principles

1. **Safety is never delegated to the LLM** — Arduino enforces hard limits
2. **Timing-sensitive logic stays local** — Host and Arduino handle real-time
3. **LLMs reason over symbols, not signals** — Places, not centimeters
4. **Memory lives on the host** — Experience accumulates locally
5. **Hardware can change without breaking the MCP** — ToF replaces ultrasonic, LLM doesn't know

---

## End State Vision

A robot where:
- Any LLM can connect via MCP
- The robot roams safely on its own
- Experience accumulates over days
- Strategy improves without retraining
- Hardware upgrades are transparent

> The robot becomes an embodied, persistent tool — not a remote-controlled toy.

---

## References

- [Micromouse algorithms](https://en.wikipedia.org/wiki/Micromouse)
- [Frontier-based exploration](https://en.wikipedia.org/wiki/Frontier-based_exploration)
- [Topological mapping](https://en.wikipedia.org/wiki/Topological_map)
- [A* pathfinding](https://en.wikipedia.org/wiki/A*_search_algorithm)
