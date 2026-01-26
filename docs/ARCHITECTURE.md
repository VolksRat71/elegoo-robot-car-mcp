# Architecture: Autonomous Navigation System

## Overview

This document describes the target architecture for transforming the Elegoo Robot Car from a remote-controlled toy into an autonomous navigation platform that Claude can command at a strategic level.

## Design Philosophy: Micromouse-Style Navigation

Instead of Claude micromanaging every movement ("forward 2s, turn 45°, check surroundings, repeat"), the system should work like a micromouse competition robot:

- **Claude decides WHERE to go** (strategic)
- **Server figures out HOW to get there** (tactical)
- **Arduino executes motor commands and reads sensors** (reactive)

---

## Current vs Target Architecture

### Current (Claude micromanages)
```
┌─────────┐    "forward 2s"     ┌─────────┐    JSON cmd    ┌─────────┐
│ Claude  │ ──────────────────► │   MCP   │ ─────────────► │ Arduino │
│         │ ◄────────────────── │ Server  │ ◄───────────── │         │
└─────────┘    "done, 15cm"     └─────────┘    response    └─────────┘
              (repeat 100x)
```

### Target (Claude is strategic, server is tactical)
```
┌─────────┐   "explore room"    ┌─────────────────────────┐    low-level    ┌─────────┐
│ Claude  │ ──────────────────► │      MCP Server         │ ◄────────────► │ Arduino │
│         │ ◄────────────────── │  • Occupancy grid       │   fast loop    │  • Motors│
└─────────┘   "found door at    │  • A* pathfinding       │   ~50ms        │  • Sensors│
              NE corner"        │  • Wall following       │                │  • Servo │
                                │  • Localization         │                └─────────┘
                                │  • SQLite map store     │
                                └─────────────────────────┘
```

---

## Three-Layer Responsibility Split

| Layer | Responsibility | Runs On | Update Frequency |
|-------|---------------|---------|------------------|
| **Strategic** | Goals, decisions, understanding | Claude | Per task |
| **Tactical** | Pathfinding, mapping, navigation | MCP Server | ~100ms |
| **Reactive** | Motor control, sensor polling, reflexes | Arduino | ~10-50ms |

### Strategic Layer (Claude)

Claude handles high-level commands:
- "Explore the room and tell me what you find"
- "Go to the waypoint called 'kitchen'"
- "Find something red"
- "Map this floor"
- "What's behind that door?"

Claude does NOT handle:
- Individual motor commands
- Obstacle avoidance decisions
- Path planning details
- Sensor polling

### Tactical Layer (MCP Server)

The server is the "brain" of the robot:

```
server/
├── src/
│   ├── navigation/
│   │   ├── grid.ts           # Occupancy grid management
│   │   ├── pathfinder.ts     # A* / Dijkstra
│   │   ├── localizer.ts      # Position estimation
│   │   └── behaviors.ts      # Wall-follow, explore, spiral search
│   ├── data/
│   │   └── map-store.ts      # SQLite for persistent maps
│   └── tools/
│       ├── explore.ts        # "explore room" → autonomous mapping
│       ├── navigate.ts       # "go to X" → path planning + execution
│       └── sensors.ts        # Raw sensor access
└── data/
    └── robot.db              # SQLite: maps, waypoints, sessions
```

### Reactive Layer (Arduino)

The Arduino is "dumb but fast":

**Inputs:**
- Motor commands (speed, direction)
- Servo commands (angle)
- Behavior triggers (scan, follow wall)

**Outputs:**
- Distance readings (continuous)
- Line sensor values (continuous)
- Odometry ticks (if encoders added)
- Behavior completion events

---

## Arduino Firmware: Slim Down

### Components to REMOVE

| Component | Size | Reason |
|-----------|------|--------|
| IRremote.* | ~50KB | No remote control needed |
| MPU6050.* | ~85KB | Complex, unreliable, server handles heading |
| RGB LED code | ~300 lines | Visual feedback unnecessary |
| Voice control | ~200 lines | Unnecessary |
| Mode button | ~100 lines | Server controls modes |
| Follow mode | ~150 lines | Server handles this behavior |
| Rocker mode | ~100 lines | No joystick control |
| LED expressions | ~200 lines | Unnecessary |
| ArduinoJson | ~176KB | Use simple parser |

**Total reduction: ~300KB+ of flash, ~1000 lines of code**

### Components to KEEP

| Component | Purpose |
|-----------|---------|
| Motor driver (TB6612) | Movement control |
| Ultrasonic (HC-SR04) | Distance sensing |
| Servo (pan only) | Rotate sensor head |
| Line sensors (3x IR) | Wall/edge detection |
| Serial protocol | Command interface |

### Components to ADD

New built-in reactive behaviors that run on Arduino:

```cpp
// Drive until obstacle detected within threshold
void CMD_DriveUntilObstacle(uint8_t speed, uint8_t threshold_cm) {
    while (getDistance() > threshold_cm) {
        driveForward(speed);
        delay(50);  // Check every 50ms
    }
    stop();
    Serial.println("{\"done\":true,\"distance\":" + String(getDistance()) + "}");
}

// Follow wall on left/right side
void CMD_FollowWall(uint8_t side, uint8_t speed, uint16_t duration_ms) {
    unsigned long start = millis();
    while (millis() - start < duration_ms) {
        int dist = scanSide(side);
        adjustMotors(dist, TARGET_WALL_DIST, speed);
        delay(20);
    }
    stop();
    Serial.println("{\"done\":true}");
}

// Scan arc and return distance array
void CMD_ScanArc(uint8_t start_angle, uint8_t end_angle, uint8_t step) {
    Serial.print("{\"distances\":[");
    for (int a = start_angle; a <= end_angle; a += step) {
        servo.write(a);
        delay(100);  // Settle time
        Serial.print(getDistance());
        if (a + step <= end_angle) Serial.print(",");
    }
    Serial.println("]}");
}

// Continuous sensor streaming mode
void CMD_StartSensorStream(uint8_t interval_ms) {
    streaming = true;
    streamInterval = interval_ms;
}
// In main loop: if (streaming) sendSensorPacket();
```

### New Command Protocol

```
Essential Commands (keep):
N=1:  Motor control       {N:1, D1:motor, D2:speed, D3:dir}
N=4:  Differential drive  {N:4, D1:left_speed, D2:right_speed}
N=5:  Servo angle         {N:5, D1:1, D2:angle}
N=21: Ultrasonic read     {N:21, D1:2}  ← D1=2 for actual cm
N=22: Line sensors        {N:22, D1:1}
N=100: Stop/Standby       {N:100}

New Commands (add):
N=30: Drive until obstacle  {N:30, D1:speed, D2:threshold_cm}
N=31: Follow wall           {N:31, D1:side, D2:speed, D3:duration_ms}
N=32: Scan arc              {N:32, D1:start_angle, D2:end_angle, D3:step}
N=33: Start sensor stream   {N:33, D1:interval_ms}
N=34: Stop sensor stream    {N:34}
```

---

## MCP Server: Navigation Module

### Occupancy Grid

```typescript
// Grid cell states
enum CellState {
    UNKNOWN = 0,
    WALL = 1,
    OPEN = 2,
    VISITED = 3,
}

// Grid management
class OccupancyGrid {
    private cells: Map<string, CellState>;
    private resolution: number = 10;  // cm per cell

    update(x: number, y: number, state: CellState): void;
    get(x: number, y: number): CellState;
    getNeighbors(x: number, y: number): CellState[];
    toAscii(): string;
    toJson(): object;
}
```

### Pathfinding

```typescript
// A* pathfinder
class Pathfinder {
    findPath(
        grid: OccupancyGrid,
        start: Point,
        goal: Point
    ): Path | null;

    // Returns next step, handles replanning on obstacle
    getNextWaypoint(
        currentPos: Point,
        path: Path,
        obstacles: Point[]
    ): Point;
}
```

### Navigation Behaviors

```typescript
// Built-in behaviors the server can execute
class NavigationBehaviors {
    // Explore unknown area using frontier-based exploration
    async explore(bounds?: Bounds): Promise<ExploreResult>;

    // Navigate to target using A* path
    async navigateTo(target: Point | string): Promise<NavigateResult>;

    // Follow wall for mapping
    async followWall(side: 'left' | 'right', duration: number): Promise<void>;

    // Spiral outward search pattern
    async spiralSearch(callback: (pos: Point) => boolean): Promise<Point | null>;
}
```

---

## Data Storage: SQLite Schema

```sql
-- Occupancy grid cells
CREATE TABLE grid_cells (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    state INTEGER NOT NULL DEFAULT 0,
    confidence REAL DEFAULT 0.5,
    last_seen TIMESTAMP,
    PRIMARY KEY (x, y)
);

-- Named waypoints
CREATE TABLE waypoints (
    name TEXT PRIMARY KEY,
    x REAL NOT NULL,
    y REAL NOT NULL,
    heading REAL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exploration sessions (for learning/replay)
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    cells_explored INTEGER DEFAULT 0,
    distance_traveled REAL DEFAULT 0,
    notes TEXT
);

-- Sensor log (optional, for debugging/replay)
CREATE TABLE sensor_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    x REAL,
    y REAL,
    heading REAL,
    distance_cm INTEGER,
    line_left INTEGER,
    line_center INTEGER,
    line_right INTEGER
);
```

---

## MCP Tools for Claude

### High-Level Tools (Claude uses these)

```typescript
// Autonomous exploration
explore_area(options?: {
    bounds?: { x: number, y: number, width: number, height: number },
    max_duration_s?: number,
    return_to_start?: boolean
}): Promise<{
    cells_mapped: number,
    obstacles_found: number,
    waypoints_discovered: string[],
    interesting_findings: string[]
}>

// Goal-based navigation
navigate_to(target: string | { x: number, y: number }): Promise<{
    success: boolean,
    path_length_cm: number,
    obstacles_avoided: number,
    final_position: { x: number, y: number }
}>

// Get current map
get_map(format: 'ascii' | 'json'): Promise<string | object>

// Save current location
mark_location(name: string, notes?: string): Promise<void>

// Plan without executing
find_path(from: string | Point, to: string | Point): Promise<{
    path: Point[],
    distance_cm: number,
    estimated_time_s: number
}>

// List known locations
list_waypoints(): Promise<Waypoint[]>
```

### Low-Level Tools (server uses internally, Claude rarely needs)

```typescript
// Direct sensor access
get_distance(): Promise<number>
get_line_sensors(): Promise<{ left: number, center: number, right: number }>
scan_arc(start: number, end: number, step: number): Promise<number[]>

// Direct movement (server uses for path execution)
drive(direction: string, speed: number, duration_ms: number): Promise<void>
drive_until_obstacle(speed: number, threshold_cm: number): Promise<number>
follow_wall(side: 'left' | 'right', duration_ms: number): Promise<void>
```

---

## Example Interaction Flow

### Claude: "Explore this room and find the door"

```
1. Claude → MCP: explore_area({ max_duration_s: 120 })

2. MCP Server internally:
   a. Start frontier-based exploration
   b. While unexplored cells exist:
      - Find nearest frontier (unknown cells adjacent to open)
      - Plan path using A*
      - Execute path:
        * Send drive commands to Arduino
        * Read sensors continuously
        * Update occupancy grid
        * Detect and mark obstacles
      - If path blocked, replan
   c. Use vision (if available) to identify "door"
   d. Mark interesting locations as waypoints

3. MCP → Claude: {
     cells_mapped: 847,
     obstacles_found: 23,
     waypoints_discovered: ["corner_nw", "corner_se", "door_east"],
     interesting_findings: ["Door found at east wall, marked as 'door_east'"]
   }

4. Claude → User: "I explored the room and found a door on the east wall.
                   The room is approximately 3m x 4m with furniture along
                   the north wall. I've saved the door location as 'door_east'."
```

---

## Implementation Phases

### Phase 1: Slim Firmware
- [ ] Remove IRremote, MPU6050, RGB, voice code
- [ ] Keep only: motors, ultrasonic, servo, line sensors
- [ ] Add: DriveUntilObstacle, ScanArc commands
- [ ] Test basic operation

### Phase 2: Server Navigation Module
- [ ] Implement OccupancyGrid class
- [ ] Implement A* Pathfinder
- [ ] Add SQLite storage for grid and waypoints
- [ ] Create NavigationBehaviors class

### Phase 3: High-Level MCP Tools
- [ ] Implement explore_area tool
- [ ] Implement navigate_to tool
- [ ] Implement get_map tool
- [ ] Wire up to Claude

### Phase 4: Refinement
- [ ] Add sensor streaming for faster updates
- [ ] Improve localization (reduce drift)
- [ ] Add visual landmark support (if camera used)
- [ ] Tune exploration algorithms

---

## Hardware Considerations

### Current Setup (works now)
- Arduino Uno (via Elegoo shield)
- TB6612 motor driver
- HC-SR04 ultrasonic
- SG90 servo (pan)
- 3x ITR20001 line sensors

### Future Improvements
| Addition | Benefit |
|----------|---------|
| Wheel encoders | Accurate odometry, reduces drift |
| Second ultrasonic (rear) | Reverse safely |
| Compass/IMU | Heading accuracy |
| Better servo | Faster scanning |

---

## References

- [Micromouse algorithms](https://en.wikipedia.org/wiki/Micromouse)
- [Frontier-based exploration](https://en.wikipedia.org/wiki/Frontier-based_exploration)
- [A* pathfinding](https://en.wikipedia.org/wiki/A*_search_algorithm)
- [Occupancy grid mapping](https://en.wikipedia.org/wiki/Occupancy_grid_mapping)
