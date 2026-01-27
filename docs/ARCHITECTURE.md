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
| Mapping | Place graph (global) + local costmap (tactical) |
| Localization | Position estimation with uncertainty |
| Path selection | A*, frontier exploration, recovery behaviors |
| Memory | Experience accumulation, place visit history |
| Behavior execution | Translate high-level intent into motion primitives |
| Health monitoring | Track link quality, command latency, system load |

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
- Health/degradation warnings

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

**Debug Tools (gated, not default LLM tools):**
```
move(v_mm_s, w_deg_s, duration_ms)  → Direct motion (time-bounded, safety-enforced)
get_raw_telemetry()                 → Raw sensor dump for debugging
```

These escape hatches remain available behind a "debug mode" flag but are not exposed in normal MCP tool listings.

---

### WorldState Schema (v1)

Lock this contract early. Improvements happen behind it.

```typescript
interface WorldState {
  // Schema version for compatibility
  schema_version: "1.0";
  timestamp_ms: number;

  // Robot state machine
  autonomy_state: "IDLE" | "EXECUTING" | "AVOIDING" | "RECOVERING" | "RELOCALIZING" | "STUCK";
  last_action: string;
  stuck_counter: number;

  // Geometry (tactical)
  geometry: {
    front_min_mm: number;
    scan_bins_mm: number[];           // e.g., 7 bins at 30° intervals
    best_gap: {
      bearing_deg: number;
      width_mm: number;
    } | null;
  };

  // Semantics (from vision, when available)
  semantics: {
    detected_objects: {
      label: string;
      bearing_deg: number;
      confidence: number;
    }[];
    current_place_tags: string[];     // "hallway", "open_area", "cluttered"
  };

  // Map summary (strategic)
  map_summary: {
    current_place: string | null;
    nearby_places: string[];
    unexplored_frontiers: number;
    loop_closure: {
      candidates: { place_id: string; score: number }[];
      confidence: number;
    };
  };

  // Confidence levels
  confidence: {
    localization: number;             // 0-1
    safety: number;                   // 0-1
    loop_closure: number;             // 0-1
  };

  // Health & timing (for degraded-mode decisions)
  health: {
    link_rtt_ms: number;
    command_age_ms: number;
    dropped_frames: number;
    last_heartbeat_ms: number;
    battery_voltage: number;
    cpu_load: number;                 // host-side
    queue_depth: number;              // pending commands
  };
}
```

LLM receives this via `observe()`. Can request `observe(mode="burst")` for richer data (e.g., camera stills, full scan array).

---

## Host Autonomy State Machine

The host runs a state machine independent of LLM timing:

```
                    ┌──────────────┐
                    │     IDLE     │
                    └──────┬───────┘
                           │ goal received
                           ▼
                    ┌──────────────┐
         ┌─────────│  EXECUTING   │◄────────────┐
         │         └──────┬───────┘             │
         │                │ obstacle_abort      │ recovery success
         │                ▼                     │
         │         ┌──────────────┐             │
         │         │   AVOIDING   │─────────────┤
         │         └──────┬───────┘             │
         │                │ repeated aborts     │
         │                ▼                     │
         │         ┌──────────────┐             │
         │         │  RECOVERING  │─────────────┘
         │         └──────┬───────┘
         │                │ low confidence
         │                ▼
         │         ┌──────────────┐
         │         │ RELOCALIZING │
         │         └──────┬───────┘
         │                │ persistent failure
         │                ▼
         │         ┌──────────────┐
         └────────►│    STUCK     │
                   └──────────────┘
```

| State | Behavior | Exits To |
|-------|----------|----------|
| IDLE | Waiting for goal | EXECUTING |
| EXECUTING | Following path, gap-following | AVOIDING, goal reached → IDLE |
| AVOIDING | Immediate obstacle response | EXECUTING (clear), RECOVERING (repeated) |
| RECOVERING | Backup → turn → rescan | EXECUTING (success), RELOCALIZING (low confidence) |
| RELOCALIZING | Scan + loop closure attempt | EXECUTING (matched), STUCK (failed) |
| STUCK | Halt, report to LLM | IDLE (new goal or manual intervention) |

The LLM sees `autonomy_state` in WorldState and can adapt strategy (e.g., "if stuck, try different approach").

---

## Mapping: Hybrid Approach

### Place Graph (Global / LLM-facing)

The **primary map structure** for long-term memory and LLM reasoning:

```
    [hallway_1] ──── [living_room] ──── [kitchen]
         │                │
    [bedroom_1]      [front_door]
```

```typescript
interface Place {
  id: string;
  signature: {
    tof_fingerprint: number[];        // Binned scan at this location
    camera_stills: string[];          // 3-5 reference images (paths)
    semantic_labels: string[];        // "couch", "doorway", "window"
  };
  tags: string[];                     // "open_area", "narrow", "cluttered"
  visit_count: number;
  last_visited: Date;
  typical_obstacles: string[];
}

interface Edge {
  from: string;
  to: string;
  action: string;                     // "forward_2m", "turn_left_90"
  success_rate: number;               // 0-1, learned over time
  typical_duration_ms: number;
}
```

**Loop closure** uses probabilistic matching:
1. ToF scan similarity (primary)
2. Visual similarity (confirmation)
3. Semantic consistency

Output: `loop_closure.candidates` with scores in WorldState.

### Local Costmap (Tactical / Internal)

A **small rolling grid** (~2m x 2m around robot) for immediate obstacle avoidance:

- Updated continuously from ToF scans
- Used by gap-following and recovery behaviors
- **Never exposed to LLM** — abstracted into `geometry.best_gap`

This isn't a contradiction: Place Graph answers "where should I go?", local costmap answers "how do I not clip that chair leg?"

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

## Data Retention & Replay

### SQLite Schema

```sql
-- Places (nodes in place graph)
CREATE TABLE places (
    id TEXT PRIMARY KEY,
    tof_fingerprint BLOB,
    tags TEXT,                        -- JSON array
    visit_count INTEGER DEFAULT 0,
    last_visited TIMESTAMP,
    typical_obstacles TEXT            -- JSON array
);

-- Edges between places
CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_place TEXT REFERENCES places(id),
    to_place TEXT REFERENCES places(id),
    action TEXT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    typical_duration_ms INTEGER
);

-- Sessions for replay/debugging
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    notes TEXT
);

-- WorldState log (for replay)
CREATE TABLE world_state_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    timestamp_ms INTEGER,
    state JSON                        -- Full WorldState snapshot
);

-- Action log (for replay)
CREATE TABLE action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    timestamp_ms INTEGER,
    action TEXT,
    params JSON,
    result JSON
);
```

### Replay Format

Log files contain interleaved WorldState + ActionResult entries:

```jsonl
{"type": "state", "ts": 1706300000000, "data": { /* WorldState */ }}
{"type": "action", "ts": 1706300000100, "action": "explore", "params": {"duration_s": 60}}
{"type": "state", "ts": 1706300000200, "data": { /* WorldState */ }}
{"type": "result", "ts": 1706300005000, "action": "explore", "result": {"places_found": 3}}
```

This enables iterating on mapping/autonomy without re-driving the robot.

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
- [ ] WorldState schema v1 + logging

**Success criteria:** No collisions, smooth motion under WiFi jitter, deterministic behavior.

---

### Phase 2: Host as Tactical Brain + MCP Contract

**Objective:** Decouple LLM reasoning time from control timing. Lock MCP tool contract early.

- [ ] Time-bounded motion primitives (`SET_TWIST`)
- [ ] Local costmap for gap-following
- [ ] Host autonomy state machine (IDLE → EXECUTING → AVOIDING → ...)
- [ ] Automatic recovery (backup → turn → rescan)
- [ ] Speed limiting near obstacles
- [ ] Action timeouts
- [ ] **MCP tools stubbed** (`explore`, `goto`, `observe`) — even if behavior is primitive

**Success criteria:** LLM can call `explore()` and get structured results. Host handles all "robot reflexes."

---

### Phase 3: Place Graph Mapping

**Objective:** Build a map useful for reasoning, not just geometry.

- [ ] Place node creation from sensor signatures
- [ ] Edge creation when moving between places
- [ ] Loop closure detection with confidence scoring
- [ ] SQLite storage for persistence
- [ ] Semantic labeling (with vision, optional)

**Success criteria:** Robot can recognize "I've been here before" and navigate between named places.

---

### Phase 4: Experience & Learning

**Objective:** Roaming improves over time.

- [ ] Track edge success/failure rates
- [ ] Track place visit frequency
- [ ] Prefer unexplored frontiers
- [ ] Avoid historically problematic areas
- [ ] Summarize experience for LLM context

**Success criteria:** Second exploration of same space is faster and more efficient than first.

---

### Phase 5: Encoders (Reliability Improvement)

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
6. **Lock the API early, improve autonomy behind it** — MCP contract is stable; implementation evolves

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
