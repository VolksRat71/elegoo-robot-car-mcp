# Autonomous Driver Architecture

The autonomous driver (`vision/autonomous_driver.py`) runs a tight 300ms control loop that captures camera frames, estimates depth using MiDaS, and makes navigation decisions without Claude latency.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MAIN LOOP (300ms)                            │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐  │
│  │  Camera  │───▶│  MiDaS   │───▶│ Depth Zones  │───▶│ Decision │  │
│  │  Frame   │    │  Depth   │    │  L / C / R   │    │  Engine  │  │
│  └──────────┘    └──────────┘    └──────────────┘    └────┬─────┘  │
│                                                           │        │
│                                    ┌──────────────────────┘        │
│                                    ▼                               │
│                          ┌─────────────────┐                       │
│                          │ Override Chain  │                       │
│                          │ (7 stages)      │                       │
│                          └────────┬────────┘                       │
│                                   │                                │
│                                   ▼                                │
│                          ┌─────────────────┐                       │
│                          │ execute_decision│───▶ Robot Motors      │
│                          └─────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Depth Zones (from MiDaS)

The camera frame is divided into regions, with top 30% (ceiling/lights) and bottom 25% (floor) ignored:

```
Camera View:
┌─────────────────────────────────────┐
│  (ignored - ceiling/lights)  30%   │
├───────────┬───────────┬─────────────┤
│           │           │             │
│   LEFT    │  CENTER   │   RIGHT     │
│   zone    │   zone    │   zone      │
│           │           │             │
├───────────┴───────────┴─────────────┤
│  (ignored - floor)           25%   │
└─────────────────────────────────────┘
```

**Values = "% blocked"** (higher = closer obstacle):

| Range | Meaning |
|-------|---------|
| 0-35% | CLEAR |
| 35-50% | CAUTION (slow down) |
| 50-70% | BLOCKED (turn away) |
| 70%+ | DANGER (stop!) |

---

## Thresholds

| Threshold | Value | Purpose |
|-----------|-------|---------|
| `clear_threshold` | 35% | Below this = safe to go |
| `obstacle_off_threshold` | 40% | Must fall below to "un-block" (hysteresis) |
| `obstacle_threshold` | 50% | Must exceed to become "blocked" |
| `danger_threshold` | 70% | Emergency stop |
| `wall_variance` | 12% | Max L/C/R difference for wall pattern |

The hysteresis (separate on/off thresholds) prevents flickering between "blocked" and "clear" when depth hovers around 50%.

---

## Decision Types

```python
class Decision(Enum):
    FORWARD = "forward"        # Full speed ahead
    FORWARD_SLOW = "forward_slow"  # Cautious forward
    TURN_LEFT = "turn_left"    # Small turn (~25°)
    TURN_RIGHT = "turn_right"
    TURN_LEFT_LARGE = "turn_left_large"   # Big turn (~45°)
    TURN_RIGHT_LARGE = "turn_right_large"
    REVERSE = "reverse"        # Back up
    STOP = "stop"              # Emergency stop
```

---

## Base Decision Logic (`make_decision`)

```
                    ┌─────────────────┐
                    │ Center > 70% ?  │
                    └────────┬────────┘
                        yes  │  no
                    ┌────────┘  └────────┐
                    ▼                    ▼
               ┌────────┐        ┌───────────────┐
               │  STOP  │        │ Wall pattern? │
               └────────┘        │ (all similar) │
                                 └───────┬───────┘
                                    yes  │  no
                                 ┌───────┘  └───────┐
                                 ▼                  ▼
                         ┌─────────────┐    ┌─────────────────┐
                         │ TURN_*_LARGE│    │ Center blocked? │
                         │ (away from  │    │   (> 50%)       │
                         │  closer)    │    └────────┬────────┘
                         └─────────────┘        yes  │  no
                                            ┌────────┘  └────────┐
                                            ▼                    ▼
                                    ┌─────────────┐      ┌──────────────┐
                                    │ TURN toward │      │ Left blocked?│
                                    │ clearer side│      └──────┬───────┘
                                    └─────────────┘         yes  │  no
                                                        ┌────────┘  └────┐
                                                        ▼                ▼
                                                 ┌────────────┐   ┌──────────────┐
                                                 │ TURN_RIGHT │   │Right blocked?│
                                                 └────────────┘   └──────┬───────┘
                                                                    yes  │  no
                                                               ┌─────────┘  └─────┐
                                                               ▼                  ▼
                                                        ┌────────────┐    ┌─────────────┐
                                                        │ TURN_LEFT  │    │   FORWARD   │
                                                        └────────────┘    │ (or _SLOW)  │
                                                                          └─────────────┘
```

---

## Override Chain

After the base decision, 7 override stages can modify it:

```
Base Decision
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. COMMITMENT FSM                                               │
│    - If committed to action & not expired → honor it            │
│    - Breaks on DANGER (>70%) or OBSTACLE during FORWARD (>50%)  │
│    - Handles wall escape sequence: REVERSE → TURN → FORWARD     │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. WALL ESCAPE                                                  │
│    - If wall pattern → commit to REVERSE, queue turn            │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. CORNER ESCAPE                                                │
│    - If L+R blocked, C not clear → escalating reverse+turn      │
│    - Level 0: 600ms, Level 1: 900ms, Level 2: 1200ms reverse    │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. NUDGE BIAS (Claude copilot)                                  │
│    - Reads nudges.json for prefer_direction, look_for, avoid    │
│    - Biases ambiguous decisions toward preferred direction      │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. HEAD SCAN OVERRIDE                                           │
│    - If servo scan found better path → use that direction       │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. CIRCLE DETECTION (soft bias)                                 │
│    - If 3+ same-direction turns → suggest opposite              │
│    - Only applies when BOTH sides safe AND similar (<15% diff)  │
│    - Won't override into blocked side                           │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. EXPLORATION BIAS                                             │
│    - Visit tracker penalizes revisited areas                    │
│    - Forces turn after 15+ consecutive forwards (wall-following)│
│    - 10% random "curiosity" turns for exploration               │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
   FINAL DECISION → execute_decision() → Robot
```

---

## Key State Machines

### Commitment FSM

Prevents oscillation by committing to forward motion after turns:

```
TURN detected → commit to FORWARD for 1.2s
                     │
                     ▼
           ┌─────────────────┐
           │ While committed │◀──────────────┐
           └────────┬────────┘               │
                    │                        │
        ┌───────────┼───────────┐            │
        ▼           ▼           ▼            │
   DANGER?     OBSTACLE?    Time up?         │
   (>70%)      (>50%)                        │
        │           │           │            │
        ▼           ▼           ▼            │
      STOP    Fresh decision   Continue──────┘
```

### Wall/Corner Escape FSM

Multi-phase escape sequence:

```
Wall/Corner detected
        │
        ▼
   ┌─────────┐
   │ REVERSE │ (400-1200ms depending on escalation)
   └────┬────┘
        │ time up
        ▼
   ┌─────────────┐
   │ TURN_*_LARGE│ (stored from original decision)
   └──────┬──────┘
          │
          ▼
   ┌─────────┐
   │ FORWARD │ (committed 1.2s)
   └─────────┘
```

---

## Pattern Detection

### Wall Pattern
All zones similar depth AND all above obstacle threshold:
```python
max(L, C, R) - min(L, C, R) < 12% AND min(L, C, R) > 50%
```

### Corner Pattern
Both sides blocked, center not clear:
```python
L > 50% AND R > 50% AND C > 35%
```

### Narrow Passage
Sides blocked but center clear:
```python
L > 50% AND R > 50% AND C < 35%
```

---

## Decision Tracing

When overrides occur, the driver logs the decision chain:

```
[TRACE] base:TURN_LEFT → circle:RIGHT → final:TURN_RIGHT
[TRACE] base:TURN_LEFT_LARGE → wall:REVERSE → final:REVERSE
[TRACE] base:FORWARD → explore:LEFT → final:TURN_LEFT
```

This makes debugging unexpected decisions much easier.

---

## Configuration

All thresholds and timing are in `vision/config.json`:

```json
{
  "clear_threshold": 35.0,
  "obstacle_threshold": 50.0,
  "obstacle_off_threshold": 40.0,
  "danger_threshold": 70.0,
  "wall_variance": 12.0,
  "forward_commitment_ms": 1200,
  "wall_reverse_ms": 400,
  "cruise_speed": 35,
  "slow_speed": 25,
  "turn_speed": 40,
  "reverse_speed": 30,
  "loop_interval_ms": 300
}
```

---

## Claude Copilot (Nudges)

Claude can influence navigation via `vision/nudges.json`:

```json
{
  "active": true,
  "goal": "Find the kitchen",
  "prefer_direction": "left",
  "bias_strength": 0.6,
  "look_for": ["refrigerator", "sink"],
  "avoid": ["person", "dog"]
}
```

The driver reads this file and biases decisions accordingly.

---

## Resource Configuration

The vision service supports tuning via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_THREADS` | `2` | CPU threads for PyTorch |
| `VISION_FPS` | `30` | Target FPS (drops frames if can't keep up) |
| `VISION_DEVICE` | `auto` | Force device: `cpu`, `cuda`, `mps`, or `auto` |

### Adaptive Frame Rate

The vision processor targets 30fps but gracefully drops frames if processing can't keep up. Check actual performance:

```bash
curl http://localhost:8765/vision/stats
# Returns: actual_fps, frames_dropped, avg_processing_ms
```

---

## Usage

```bash
# Normal run (30 seconds)
python vision/autonomous_driver.py

# Longer duration, cautious mode
python vision/autonomous_driver.py --duration 60 --cautious

# Dry run (no motor commands, just logs decisions)
python vision/autonomous_driver.py --dry-run

# With resource tuning
VISION_THREADS=4 VISION_FPS=30 python vision/autonomous_driver.py
```
