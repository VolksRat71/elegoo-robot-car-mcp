#!/bin/bash
# Script to create GitHub Issues and Project Board for elegoo-robot-car-mcp
#
# Prerequisites:
#   - GitHub CLI (gh) installed and authenticated
#   - Run: gh auth login
#
# Usage:
#   chmod +x .github/scripts/setup-issues-and-project.sh
#   ./.github/scripts/setup-issues-and-project.sh

set -e

REPO="VolksRat71/elegoo-robot-car-mcp"

echo "Creating GitHub Issues and Project Board for $REPO"
echo "=================================================="

# Check if gh is installed and authenticated
if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed."
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    echo "Error: Not authenticated with GitHub CLI."
    echo "Run: gh auth login"
    exit 1
fi

# Create labels first
echo ""
echo "Creating labels..."
gh label create "bug" --description "Something isn't working" --color "d73a4a" --repo "$REPO" 2>/dev/null || echo "  Label 'bug' already exists"
gh label create "enhancement" --description "New feature or request" --color "a2eeef" --repo "$REPO" 2>/dev/null || echo "  Label 'enhancement' already exists"
gh label create "hardware" --description "Hardware-related issue" --color "f9d0c4" --repo "$REPO" 2>/dev/null || echo "  Label 'hardware' already exists"
gh label create "sensor" --description "Sensor-related issue" --color "c5def5" --repo "$REPO" 2>/dev/null || echo "  Label 'sensor' already exists"
gh label create "connection" --description "Connection/networking issue" --color "fef2c0" --repo "$REPO" 2>/dev/null || echo "  Label 'connection' already exists"
gh label create "navigation" --description "Navigation and mapping" --color "bfdadc" --repo "$REPO" 2>/dev/null || echo "  Label 'navigation' already exists"
gh label create "camera" --description "Camera-related" --color "d4c5f9" --repo "$REPO" 2>/dev/null || echo "  Label 'camera' already exists"
gh label create "blocked" --description "Blocked by external factor" --color "b60205" --repo "$REPO" 2>/dev/null || echo "  Label 'blocked' already exists"
gh label create "feature" --description "New feature" --color "0e8a16" --repo "$REPO" 2>/dev/null || echo "  Label 'feature' already exists"
gh label create "ai/ml" --description "AI and Machine Learning" --color "5319e7" --repo "$REPO" 2>/dev/null || echo "  Label 'ai/ml' already exists"

echo ""
echo "Creating issues from KNOWN_ISSUES.md..."

# Issue 1: WiFi/TCP Connection Drops
ISSUE1=$(gh issue create --repo "$REPO" \
  --title "WiFi/TCP Connection Drops Intermittently" \
  --label "bug,connection" \
  --body "$(cat <<'EOF'
## Description
The TCP connection to the robot (port 100) drops intermittently, especially:
- After idle periods
- During rapid command sequences
- Sometimes mid-sequence

## Current Status
**Partially mitigated, not fully solved**

## Mitigations implemented (2025-01-25):
- Command queue to serialize all robot commands (one in-flight at a time)
- Improved socket error handling with automatic reconnection
- Heartbeat interval increased from 3s to 10s to reduce interference
- Sequences abort gracefully on connection loss
- Emergency stop bypasses queue and clears pending commands

## Root Cause
The ESP32-S3 module running Elegoo's stock firmware handles the WiFi/TCP server. We cannot modify this firmware. The Elegoo mobile app appears to work more reliably, suggesting there may be protocol nuances we're missing.

## Potential Investigations
- [ ] Sniff traffic from Elegoo app to see if they use different protocol/timing
- [ ] Check if WebSocket vs raw TCP makes a difference
- [ ] Investigate if there's a specific keep-alive or handshake sequence
EOF
)")
echo "  Created: $ISSUE1"

# Issue 2: Ultrasonic Sensor
ISSUE2=$(gh issue create --repo "$REPO" \
  --title "Ultrasonic Sensor Returns Boolean Instead of Distance Values" \
  --label "bug,sensor,hardware" \
  --body "$(cat <<'EOF'
## Description
The ultrasonic sensor (N=21 command) does not return actual distance values in centimeters. Instead:
- With D1=1: Returns `{1_true}` or `{1_false}` for obstacle detection
- With D1=2: Should return distance but returns `{1_0}` or similar

## Current Status
**Unresolved**

## Current Workaround
The `get_distance` tool returns estimated values based on boolean obstacle detection:
- `true` (obstacle detected) → reports 15cm
- `false` (clear) → reports 100cm

## Possible Causes
- Firmware bug in stock Elegoo firmware
- Different sensor model than expected
- Command parameters incorrect

## Files Affected
- `server/src/robot-client-stock.ts` - `getDistance()`, `hasObstacle()`
- `server/src/tools/sensors.ts`
EOF
)")
echo "  Created: $ISSUE2"

# Issue 3: ESP32 Firmware
ISSUE3=$(gh issue create --repo "$REPO" \
  --title "Cannot Flash Custom Firmware via USB-C" \
  --label "enhancement,hardware,blocked" \
  --body "$(cat <<'EOF'
## Description
The ESP32-S3-WROOM-1 on the ESP32S3-Camera-V1.0 board has a USB-C port, but:
- Does not appear as a USB device when connected to computer
- Tried bootloader mode (BOOT + RESET sequence)
- Installed CH340 driver (not needed for ESP32-S3 native USB)
- The USB-C port appears to be **power-only**, not connected to USB data lines

## Current Status
**Blocked**

## Hardware Details
- Chip: ESP32-S3-WROOM-1 (Espressif)
- Board: ESP32S3-Camera-V1.0
- The ESP32-S3 has native USB support, so no external UART chip needed IF the USB lines were connected

## Alternatives to Explore
- [ ] Use a USB-to-TTL adapter (FTDI, CP2102) connected to TX/RX pins on the board
- [ ] Check if Elegoo sells a programming dock
- [ ] Find alternative ESP32-CAM board with working USB programming

## Why This Matters
Custom ESP32 firmware would let us:
- Fix connection stability at the source
- Add WebSocket support for more reliable connections
- Get proper ultrasonic distance readings
- Add more features without Arduino modification
EOF
)")
echo "  Created: $ISSUE3"

# Issue 4: Line Tracking Sensors
ISSUE4=$(gh issue create --repo "$REPO" \
  --title "Line Tracking Sensors Async Response Not Fully Integrated" \
  --label "bug,sensor" \
  --body "$(cat <<'EOF'
## Description
The line tracking sensors (N=22 command) return data asynchronously. Current implementation sends the command but doesn't properly wait for/parse the response.

## Current Status
**Partial implementation**

## Files Affected
- `server/src/robot-client-stock.ts` - `getLineSensors()`
- `server/src/tools/sensors.ts`

## Tasks
- [ ] Implement proper async response handling
- [ ] Parse line sensor data correctly
- [ ] Add timeout handling for missing responses
EOF
)")
echo "  Created: $ISSUE4"

# Issue 5: Position Tracking Drift
ISSUE5=$(gh issue create --repo "$REPO" \
  --title "Position Tracking Dead Reckoning Drift" \
  --label "enhancement,navigation" \
  --body "$(cat <<'EOF'
## Description
Position estimation uses dead reckoning based on:
- Movement direction and duration
- Assumed speed
- Turn angles

This accumulates error over time. The robot's actual position will drift from estimated position, especially after:
- Multiple turns
- Wheel slippage
- Obstacle collisions

## Current Status
**Expected behavior, needs improvement**

## Future Solutions
- [ ] Visual landmark recognition for position correction
- [ ] Use camera to identify known objects/locations
- [ ] Implement SLAM-lite with obstacle map
- [ ] Integrate with environment mapping feature
EOF
)")
echo "  Created: $ISSUE5"

# Issue 6: Video Streaming
ISSUE6=$(gh issue create --repo "$REPO" \
  --title "Add Video Streaming Support" \
  --label "enhancement,camera" \
  --body "$(cat <<'EOF'
## Description
Camera only captures still images via HTTP GET to `/capture`. Video streaming would require:
- MJPEG stream parsing
- Higher bandwidth handling
- Different MCP tool design (streaming vs request/response)

## Current Status
**By design (current implementation)**

The stock firmware does support MJPEG streaming (used by Elegoo app), but implementing this in MCP is non-trivial.

## Implementation Tasks
- [ ] Research MJPEG stream parsing options
- [ ] Design streaming architecture for MCP
- [ ] Implement stream handler
- [ ] Handle bandwidth/performance considerations
EOF
)")
echo "  Created: $ISSUE6"

echo ""
echo "Creating feature issues from roadmap..."

# Issue 7: Environment Mapping
ISSUE7=$(gh issue create --repo "$REPO" \
  --title "Environment Mapping Using All Sensors" \
  --label "feature,navigation,ai/ml" \
  --body "$(cat <<'EOF'
## Description
Implement environment mapping/learning using all available sensors:
- Camera (visual recognition)
- Infrared sensors (proximity detection)
- Ultrasonic sensors (distance measurement)

## Goal
Enable the robot to build a spatial understanding of its environment that can be used for autonomous navigation.

## Technical Approach
1. Combine sensor data for multi-modal mapping
2. Create a spatial database of observed features
3. Use sensor fusion for more accurate positioning
4. Build obstacle maps from sensor readings

## Related Features
- Named location navigation
- Position history database
- Camera-to-text pipeline
EOF
)")
echo "  Created: $ISSUE7"

# Issue 8: Named Location Navigation
ISSUE8=$(gh issue create --repo "$REPO" \
  --title "Named Location Navigation (\"Go to the master bedroom\")" \
  --label "feature,navigation,ai/ml" \
  --body "$(cat <<'EOF'
## Description
Enable natural language navigation commands like "go to the master bedroom" where the robot can confidently drive to a named location autonomously.

## Current Behavior
Robot navigation is manual with step-by-step commands:
- "go forward 2s"
- "turn 45°"
- "check surroundings"
- "process"
- "repeat"

## Desired Behavior
- User says "go to the master bedroom"
- Robot plans optimal path from current location
- Robot navigates autonomously using learned map
- Robot arrives at destination with confidence

## Prerequisites
- Environment mapping must be implemented
- Position tracking accuracy needs improvement
- Named locations need to be defined and stored

## Implementation Tasks
- [ ] Design location naming/labeling system
- [ ] Implement path planning algorithm
- [ ] Create autonomous navigation controller
- [ ] Add confidence scoring for arrival detection
- [ ] Handle obstacles and replanning
EOF
)")
echo "  Created: $ISSUE8"

# Issue 9: Position History Database
ISSUE9=$(gh issue create --repo "$REPO" \
  --title "Position/Vector History Database" \
  --label "feature,navigation" \
  --body "$(cat <<'EOF'
## Description
Build a database that stores position history - vectors and locations where the robot has been.

## Purpose
- Track movement patterns over time
- Enable path replay and learning
- Support environment mapping
- Provide data for navigation planning

## Technical Design
- Store position vectors (x, y, heading)
- Timestamp each position record
- Associate sensor readings with positions
- Support efficient spatial queries

## Data Structure (proposed)
\`\`\`typescript
interface PositionRecord {
  id: string;
  timestamp: Date;
  position: {
    x: number;
    y: number;
    heading: number;  // degrees
  };
  confidence: number;
  sensorSnapshot?: {
    ultrasonic?: number;
    infrared?: boolean[];
    cameraHash?: string;
  };
  label?: string;  // for named locations
}
\`\`\`

## Implementation Tasks
- [ ] Design database schema
- [ ] Choose storage backend (SQLite, JSON file, etc.)
- [ ] Implement position recording
- [ ] Add spatial query capabilities
- [ ] Create visualization/debug tools
EOF
)")
echo "  Created: $ISSUE9"

# Issue 10: Camera-to-Text Pipeline
ISSUE10=$(gh issue create --repo "$REPO" \
  --title "Camera-to-Text Pipeline Using Local Models" \
  --label "feature,camera,ai/ml" \
  --body "$(cat <<'EOF'
## Description
Improve the camera pipeline by using local models to translate images into a text stream describing the scene.

## Example Output
Raw image → Local vision model → Text description:
> "red couch on right, grey carpet in front, person to left"

## Rationale
The robot can reason faster off text than trying to do raw image processing in real time. Text descriptions:
- Are more compact than images
- Can be processed by language models efficiently
- Enable semantic understanding of the environment
- Support natural language queries about surroundings

## Technical Approach
1. Capture image from camera
2. Process through local vision model (e.g., LLaVA, BLIP, etc.)
3. Generate structured text description
4. Store/stream text for navigation decisions

## Implementation Tasks
- [ ] Research suitable local vision models
- [ ] Set up model inference pipeline
- [ ] Design output format (structured vs. natural text)
- [ ] Benchmark performance (latency, accuracy)
- [ ] Integrate with navigation system
- [ ] Add caching for repeated scenes

## Considerations
- Model size vs. inference speed tradeoff
- GPU/CPU requirements
- Consistency of descriptions
- Handling edge cases (darkness, motion blur, etc.)
EOF
)")
echo "  Created: $ISSUE10"

# Issue 11: Text-Based Reasoning
ISSUE11=$(gh issue create --repo "$REPO" \
  --title "Text-Based Reasoning for Faster Processing" \
  --label "feature,ai/ml,navigation" \
  --body "$(cat <<'EOF'
## Description
Enable the robot to reason about its environment using text descriptions rather than raw sensor data, allowing for faster decision-making.

## Architecture
\`\`\`
Sensors → Text Description → LLM Reasoning → Action
\`\`\`

Instead of:
\`\`\`
Sensors → Complex Processing → Action
\`\`\`

## Benefits
- Leverage existing LLM capabilities for reasoning
- More interpretable decision-making
- Easier to debug and adjust behavior
- Natural integration with voice commands

## Example Flow
1. Camera sees: [image of hallway]
2. Vision model outputs: "hallway ahead, door on left (open), wall on right, hardwood floor"
3. User command: "go to the kitchen"
4. LLM reasons: "Kitchen is through the open door on the left, turn left and proceed"
5. Robot executes: turn_left(), move_forward()

## Implementation Tasks
- [ ] Define text description schema
- [ ] Create reasoning prompt templates
- [ ] Implement action planning from text
- [ ] Add feedback loop for corrections
- [ ] Test and tune performance

## Prerequisites
- Camera-to-text pipeline
- Environment mapping
- Position history database
EOF
)")
echo "  Created: $ISSUE11"

echo ""
echo "Creating GitHub Project Board..."

# Create project board
PROJECT_URL=$(gh project create --owner "VolksRat71" --title "Robot Car Development" --format json 2>/dev/null | jq -r '.url' || echo "")

if [ -n "$PROJECT_URL" ] && [ "$PROJECT_URL" != "null" ]; then
    echo "  Created project: $PROJECT_URL"

    # Get project number from URL
    PROJECT_NUM=$(echo "$PROJECT_URL" | grep -oP 'projects/\K\d+')

    echo ""
    echo "Adding issues to project board..."

    # Add all issues to the project
    for issue_url in "$ISSUE1" "$ISSUE2" "$ISSUE3" "$ISSUE4" "$ISSUE5" "$ISSUE6" "$ISSUE7" "$ISSUE8" "$ISSUE9" "$ISSUE10" "$ISSUE11"; do
        if [ -n "$issue_url" ]; then
            gh project item-add "$PROJECT_NUM" --owner "VolksRat71" --url "$issue_url" 2>/dev/null && echo "  Added: $issue_url" || echo "  Failed to add: $issue_url"
        fi
    done
else
    echo "  Note: Could not create project board (may require different permissions)"
    echo "  You can create it manually at: https://github.com/VolksRat71/elegoo-robot-car-mcp/projects"
fi

echo ""
echo "=================================================="
echo "Setup complete!"
echo ""
echo "Issues created:"
echo "  KNOWN ISSUES:"
echo "    - WiFi/TCP Connection Drops Intermittently"
echo "    - Ultrasonic Sensor Returns Boolean Instead of Distance"
echo "    - Cannot Flash Custom Firmware via USB-C"
echo "    - Line Tracking Sensors Async Response Not Fully Integrated"
echo "    - Position Tracking Dead Reckoning Drift"
echo "    - Add Video Streaming Support"
echo ""
echo "  FEATURE REQUESTS:"
echo "    - Environment Mapping Using All Sensors"
echo "    - Named Location Navigation"
echo "    - Position/Vector History Database"
echo "    - Camera-to-Text Pipeline Using Local Models"
echo "    - Text-Based Reasoning for Faster Processing"
echo ""
echo "View issues at: https://github.com/$REPO/issues"
