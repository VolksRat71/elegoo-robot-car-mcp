# Elegoo Robot Car MCP Server

An MCP (Model Context Protocol) server for controlling the Elegoo Smart Robot Car V4.0 via Claude or other MCP-compatible AI assistants.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Elegoo Robot Car                        │
│  ┌──────────────┐    Serial     ┌──────────────────────┐   │
│  │   Arduino    │◄────9600────►│   ESP32-S3           │   │
│  │  (motors,    │              │  (WiFi AP + TCP:100  │   │
│  │   sensors)   │              │   + Camera HTTP:80)  │   │
│  └──────────────┘              └──────────────────────┘   │
│                                         ▲                  │
└─────────────────────────────────────────│──────────────────┘
                                          │ WiFi (192.168.4.1)
                                          ▼
                              ┌──────────────────┐
                              │   MCP Server     │
                              │  (this project)  │
                              └──────────────────┘
                                          ▲
                                          │ MCP Protocol
                                          ▼
                              ┌──────────────────┐
                              │   Claude / AI    │
                              └──────────────────┘
```

## Features

### Working
- **Movement**: drive, turn, emergency stop
- **Camera**: capture images via HTTP endpoint
- **Servo**: pan camera left/right (0-180 degrees)
- **Sequences**: execute multi-step action sequences
- **Patterns**: predefined movement patterns (look_around, square, etc.)
- **Waypoints**: save and navigate to named positions (dead reckoning)
- **Connection recovery**: auto-reconnect on WiFi drops

### Partially Working
- **Ultrasonic sensor**: returns boolean obstacle detection only (true/false), not distance in cm
- **Line tracking sensors**: async response, not fully integrated

### Not Working
- **Precise distance readings**: firmware returns 0 or binary obstacle detection
- **Custom ESP32 firmware**: USB-C port appears to be power-only, can't flash

## Installation

```bash
cd server
npm install
npm run build
```

## Usage

### Connect to Robot WiFi
1. Power on the Elegoo robot
2. Connect your computer to the `ELEGOO-XXXX` WiFi network
3. Robot IP is `192.168.4.1`

### Run the MCP Server

**Stdio mode (for Claude Desktop):**
```bash
npm start
```

**HTTP/SSE mode (for development):**
```bash
npm run dev
```

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elegoo-robot": {
      "command": "node",
      "args": ["/path/to/elegoo-robot-car-mcp/server/dist/index.js"],
      "env": {
        "ROBOT_HOST": "192.168.4.1",
        "ROBOT_PORT": "100"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `drive` | Move robot in a direction with optional duration |
| `safe_drive` | Drive with obstacle checking (limited by sensor) |
| `turn` | Turn robot by degrees |
| `emergency_stop` | Immediately stop all movement |
| `look` | Pan camera servo (0=left, 90=center, 180=right) |
| `capture_image` | Take a photo from the robot's camera |
| `get_distance` | Read ultrasonic sensor (returns obstacle boolean) |
| `get_line_sensors` | Read line tracking sensors |
| `scan_surroundings` | Pan and scan for obstacles |
| `get_status` | Get robot connection status |
| `get_position` | Get estimated position (dead reckoning) |
| `reset_position` | Reset position to origin |
| `save_waypoint` | Save current position as named waypoint |
| `navigate_to` | Navigate to saved waypoint |
| `list_waypoints` | List all saved waypoints |
| `set_mode` | Set robot operating mode |
| `execute_sequence` | Run a sequence of actions |
| `execute_pattern` | Run a predefined pattern |

## Project Structure

```
elegoo-robot-car-mcp/
├── server/
│   ├── src/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── robot-client-stock.ts # TCP client for Elegoo firmware
│   │   ├── robot-client.ts       # Client factory
│   │   ├── map-store.ts          # Position tracking & waypoints
│   │   └── tools/
│   │       ├── movement.ts       # drive, turn, stop
│   │       ├── vision.ts         # camera capture
│   │       ├── sensors.ts        # ultrasonic, line tracking
│   │       ├── navigation.ts     # waypoints, position
│   │       ├── sequences.ts      # multi-step sequences
│   │       └── system.ts         # status, mode
│   └── data/
│       └── map.db                # SQLite for waypoints
├── firmware/
│   └── arduino/                  # Stock Elegoo Arduino firmware
└── docs/
    ├── KNOWN_ISSUES.md
    └── ROADMAP.md
```

## Protocol

The robot uses Elegoo's stock firmware protocol over TCP port 100:

```json
{"H":"1","N":1,"D1":0,"D2":125,"D3":1}
```

- `H`: Header (always "1")
- `N`: Command number
- `D1-D4`: Parameters

Key commands:
- N=1: Motor control
- N=3: Car direction
- N=5: Servo control
- N=21: Ultrasonic sensor
- N=22: Line tracking
- N=100: Standby mode

Camera is accessed via HTTP at `http://192.168.4.1/capture`.

## Known Issues

See [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md)

## License

MIT
