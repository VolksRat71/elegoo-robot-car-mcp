# Dashboard API Contract

The dashboard expects these endpoints from the server.

---

## GET `/api/snapshot`

Polled every 1.5 seconds. Returns current robot state and vision data.

### Response

```typescript
{
  timestamp: number;              // Unix timestamp ms
  robot_connected: boolean;       // Is robot link active?
  vision_available: boolean;      // Is camera/vision pipeline ready?

  // Images (base64 JPEG)
  camera_image?: string;          // Raw camera frame
  depth_image?: string;           // Depth colormap visualization
  annotated_image?: string;       // Camera with detection bounding boxes

  // Depth data
  depth?: {
    center_depth: number;         // 0-1, normalized depth at center
    depth_zones: {
      left: number;               // 0-1
      center: number;             // 0-1
      right: number;              // 0-1
    };
    image_size: { width: number; height: number };
  };

  // Object detection
  detection?: {
    detected_objects: DetectedObject[];
    count: number;
  };

  // Full world state
  world_state: WorldState;
}
```

### DetectedObject

```typescript
{
  label: string;           // e.g. "person", "chair", "dog"
  bearing_deg: number;     // -30 to +30, angle from center
  confidence: number;      // 0-1
  bbox?: {                 // Optional bounding box
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}
```

### WorldState

```typescript
{
  schema_version: string;  // e.g. "1.0"
  timestamp_ms: number;

  autonomy_state: 'IDLE' | 'EXECUTING' | 'AVOIDING' | 'RECOVERING' | 'RELOCALIZING' | 'STUCK';
  last_action: string;
  stuck_counter: number;

  geometry: {
    front_min_mm: number;           // Closest obstacle distance
    scan_bins_mm: number[];         // Depth scan bins
    best_gap: {                     // Best path forward
      bearing_deg: number;
      width_mm: number;
    } | null;
  };

  semantics: {
    detected_objects: DetectedObject[];
    current_place_tags: string[];   // e.g. ["indoor", "kitchen"]
  };

  map_summary: {
    current_place: string | null;
    nearby_places: string[];
    unexplored_frontiers: number;
    loop_closure: {
      candidates: { place_id: string; score: number }[];
      confidence: number;
    };
  };

  confidence: {
    localization: number;   // 0-1
    safety: number;         // 0-1
    loop_closure: number;   // 0-1
  };

  health: {
    link_rtt_ms: number;
    command_age_ms: number;
    dropped_frames: number;
    last_heartbeat_ms: number;
    battery_voltage: number;
    queue_depth: number;
  };
}
```

---

## POST `/api/command`

Send control commands to the robot.

### Request Body

```typescript
{
  command: 'drive' | 'turn' | 'stop' | 'explore';
  params?: Record<string, unknown>;
}
```

### Commands

#### `drive`
```json
{
  "command": "drive",
  "params": {
    "direction": "forward" | "backward" | "left" | "right" | "stop",
    "speed": 50,          // 0-100
    "duration_ms": 300    // How long to drive
  }
}
```

#### `turn`
```json
{
  "command": "turn",
  "params": {
    "degrees": 30,        // Positive = right, negative = left
    "speed": 40           // 0-100
  }
}
```

#### `stop`
```json
{
  "command": "stop"
}
```

#### `explore`
```json
{
  "command": "explore",
  "params": {
    "duration_s": 15      // Autonomous exploration duration
  }
}
```

### Response

```typescript
{
  success: boolean;
  message?: string;       // Success message
  error?: string;         // Error description if failed
}
```

---

---

## GET `/api/decisions`

Polled alongside snapshot. Returns copilot state and decision history.

### Response

```typescript
{
  copilot_active: boolean;    // When true, dashboard shows queue instead of manual controls
  decisions: Decision[];      // Last 20 "interesting" decisions
}
```

### Decision

```typescript
{
  timestamp_ms: number;       // When decision was made
  depth: {
    left: number;             // Depth reading (0-100 scale)
    center: number;
    right: number;
  };
  trace: string[];            // Decision chain, e.g. ["base:TURN_LEFT", "circle:RIGHT"]
  final: string;              // Final decision before commit
  committed: string;          // What actually executed (may differ if overridden)
  corner_level: number;       // Corner detection level (0 = none)
}
```

---

## DELETE `/api/decisions`

Clears the decision queue.

### Response

```
204 No Content
```

---

## Minimal Mock Server

For testing, return this from `/api/snapshot`:

```json
{
  "timestamp": 1706000000000,
  "robot_connected": true,
  "vision_available": true,
  "world_state": {
    "schema_version": "1.0",
    "timestamp_ms": 1706000000000,
    "autonomy_state": "IDLE",
    "last_action": "none",
    "stuck_counter": 0,
    "geometry": {
      "front_min_mm": 500,
      "scan_bins_mm": [],
      "best_gap": null
    },
    "semantics": {
      "detected_objects": [],
      "current_place_tags": []
    },
    "map_summary": {
      "current_place": null,
      "nearby_places": [],
      "unexplored_frontiers": 0,
      "loop_closure": {
        "candidates": [],
        "confidence": 0
      }
    },
    "confidence": {
      "localization": 0.5,
      "safety": 0.8,
      "loop_closure": 0
    },
    "health": {
      "link_rtt_ms": 10,
      "command_age_ms": 0,
      "dropped_frames": 0,
      "last_heartbeat_ms": 0,
      "battery_voltage": 7.4,
      "queue_depth": 0
    }
  }
}
```

For `/api/command`, just return:

```json
{
  "success": true,
  "message": "Command received"
}
```
