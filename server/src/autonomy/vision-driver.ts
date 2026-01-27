/**
 * Vision-based autonomous driver
 * Uses MiDaS depth estimation for obstacle avoidance without LIDAR
 *
 * Calibrated thresholds from sample collection (2026-01-27):
 * - Clear baseline: ~14% center, ~24-25% L/R
 * - Obstacle at 1ft: ~42% in affected zone
 * - Very close (<6in): ~70% center
 * - Wall (uniform): ~44-46% all zones
 */

import { getVisionClient } from "../vision-client.js";
import { getRobotClient } from "../robot-client.js";
import { getAutonomyStateMachine } from "./state-machine.js";
import { getMapStore } from "../map-store.js";
import { getSessionLogger } from "./logger.js";

// Calibrated thresholds (percentages)
const THRESHOLDS = {
  CLEAR: 25, // Below this = safe to proceed
  OBSTACLE: 40, // Above this = obstacle detected
  DANGER: 60, // Above this = STOP immediately
  WALL_VARIANCE: 10, // If all zones within this range, it's a wall
};

// Speed settings (cautious)
const SPEEDS = {
  CRUISE: 35, // Normal forward speed
  SLOW: 25, // Cautious forward speed
  TURN: 40, // Turn speed
  REVERSE: 30, // Backup speed
};

// Timing
const TIMING = {
  LOOP_INTERVAL_MS: 500, // Time between decisions
  DRIVE_DURATION_MS: 400, // How long to drive per command
  TURN_DEGREES_SMALL: 30, // Small avoidance turn
  TURN_DEGREES_LARGE: 60, // Large avoidance turn
  REVERSE_DURATION_MS: 300, // Backup duration
};

// Decision types
type Decision =
  | "FORWARD"
  | "FORWARD_SLOW"
  | "TURN_LEFT"
  | "TURN_RIGHT"
  | "TURN_LEFT_LARGE"
  | "TURN_RIGHT_LARGE"
  | "REVERSE"
  | "STOP"
  | "STUCK";

interface DepthZones {
  left: number;
  center: number;
  right: number;
}

interface DriverState {
  running: boolean;
  lastDecision: Decision;
  consecutiveStops: number;
  smoothedDepth: DepthZones;
  decisionHistory: Decision[];
  startTime: number;
  totalDistance: number;
  turnCount: number;
}

// Exponential moving average alpha (0-1, lower = more smoothing)
const EMA_ALPHA = 0.4;

let driverState: DriverState | null = null;

/**
 * Apply exponential moving average to smooth depth readings
 */
function smoothDepth(current: DepthZones, previous: DepthZones): DepthZones {
  return {
    left: EMA_ALPHA * current.left + (1 - EMA_ALPHA) * previous.left,
    center: EMA_ALPHA * current.center + (1 - EMA_ALPHA) * previous.center,
    right: EMA_ALPHA * current.right + (1 - EMA_ALPHA) * previous.right,
  };
}

/**
 * Check if depth pattern indicates a wall (uniform across all zones)
 */
function isWallPattern(depth: DepthZones): boolean {
  const values = [depth.left, depth.center, depth.right];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min < THRESHOLDS.WALL_VARIANCE && min > THRESHOLDS.OBSTACLE;
}

/**
 * Check if depth pattern indicates a narrow passage
 */
function isNarrowPassage(depth: DepthZones): boolean {
  return (
    depth.left > THRESHOLDS.OBSTACLE &&
    depth.right > THRESHOLDS.OBSTACLE &&
    depth.center < THRESHOLDS.CLEAR
  );
}

/**
 * Make a decision based on depth zones
 */
function makeDecision(depth: DepthZones, state: DriverState): Decision {
  const { left, center, right } = depth;

  // DANGER: Very close obstacle - STOP immediately
  if (center > THRESHOLDS.DANGER) {
    return "STOP";
  }

  // Wall detected - need to turn around
  if (isWallPattern(depth)) {
    // Alternate turn direction to avoid loops
    const turnRight = state.turnCount % 2 === 0;
    return turnRight ? "TURN_RIGHT_LARGE" : "TURN_LEFT_LARGE";
  }

  // Narrow passage - proceed slowly through center
  if (isNarrowPassage(depth)) {
    return "FORWARD_SLOW";
  }

  // Center blocked
  if (center > THRESHOLDS.OBSTACLE) {
    // Turn toward the clearer side
    if (left < right) {
      return left < THRESHOLDS.OBSTACLE ? "TURN_LEFT" : "TURN_LEFT_LARGE";
    } else {
      return right < THRESHOLDS.OBSTACLE ? "TURN_RIGHT" : "TURN_RIGHT_LARGE";
    }
  }

  // Left side blocked
  if (left > THRESHOLDS.OBSTACLE && right < THRESHOLDS.OBSTACLE) {
    return "TURN_RIGHT";
  }

  // Right side blocked
  if (right > THRESHOLDS.OBSTACLE && left < THRESHOLDS.OBSTACLE) {
    return "TURN_LEFT";
  }

  // Both sides have some obstruction but center is clear
  if (left > THRESHOLDS.CLEAR || right > THRESHOLDS.CLEAR) {
    return "FORWARD_SLOW";
  }

  // All clear - proceed normally
  return "FORWARD";
}

/**
 * Execute a decision
 */
async function executeDecision(decision: Decision): Promise<boolean> {
  const robot = getRobotClient();
  const mapStore = getMapStore();
  const logger = getSessionLogger();

  let result: { success: boolean };

  switch (decision) {
    case "FORWARD":
      result = await robot.drive("forward", SPEEDS.CRUISE, TIMING.DRIVE_DURATION_MS);
      if (result.success) {
        mapStore.estimateMovement("forward", SPEEDS.CRUISE, TIMING.DRIVE_DURATION_MS);
      }
      break;

    case "FORWARD_SLOW":
      result = await robot.drive("forward", SPEEDS.SLOW, TIMING.DRIVE_DURATION_MS);
      if (result.success) {
        mapStore.estimateMovement("forward", SPEEDS.SLOW, TIMING.DRIVE_DURATION_MS);
      }
      break;

    case "TURN_LEFT":
      result = await robot.turn(-TIMING.TURN_DEGREES_SMALL, SPEEDS.TURN);
      break;

    case "TURN_RIGHT":
      result = await robot.turn(TIMING.TURN_DEGREES_SMALL, SPEEDS.TURN);
      break;

    case "TURN_LEFT_LARGE":
      result = await robot.turn(-TIMING.TURN_DEGREES_LARGE, SPEEDS.TURN);
      break;

    case "TURN_RIGHT_LARGE":
      result = await robot.turn(TIMING.TURN_DEGREES_LARGE, SPEEDS.TURN);
      break;

    case "REVERSE":
      result = await robot.drive("backward", SPEEDS.REVERSE, TIMING.REVERSE_DURATION_MS);
      if (result.success) {
        mapStore.estimateMovement("backward", SPEEDS.REVERSE, TIMING.REVERSE_DURATION_MS);
      }
      break;

    case "STOP":
    case "STUCK":
    default:
      result = await robot.emergencyStop();
      break;
  }

  // Log the action
  logger.logAction(
    "vision_drive",
    { decision },
    { success: result.success }
  );

  return result.success;
}

/**
 * Get current depth zones from vision
 */
async function getDepthZones(): Promise<DepthZones | null> {
  const visionClient = getVisionClient();
  const robot = getRobotClient();

  try {
    // Capture image from robot camera
    const imageResult = await robot.captureImage();
    const imageData = imageResult.data as { image?: string } | undefined;
    if (!imageResult.success || !imageData?.image) {
      return null;
    }

    // Analyze with vision service
    const analysis = await visionClient.analyze(imageData.image, {
      runDepth: true,
      runDetection: false,
    });

    if (!analysis.success || !analysis.depth) {
      return null;
    }

    // Convert from 0-1 to percentage
    return {
      left: analysis.depth.depth_zones.left * 100,
      center: analysis.depth.depth_zones.center * 100,
      right: analysis.depth.depth_zones.right * 100,
    };
  } catch {
    return null;
  }
}

/**
 * Main driver loop
 */
async function driverLoop(duration_s: number): Promise<void> {
  if (!driverState) return;

  const endTime = Date.now() + duration_s * 1000;
  const stateMachine = getAutonomyStateMachine();
  const logger = getSessionLogger();

  stateMachine.transition({ type: "GOAL_RECEIVED" });

  while (driverState.running && Date.now() < endTime) {
    // Get current depth
    const depth = await getDepthZones();

    if (!depth) {
      // Vision failed - stop and wait
      console.error("[VisionDriver] Failed to get depth, stopping");
      await executeDecision("STOP");
      driverState.consecutiveStops++;

      if (driverState.consecutiveStops > 5) {
        console.error("[VisionDriver] Too many vision failures, aborting");
        driverState.running = false;
        break;
      }

      await new Promise((r) => setTimeout(r, TIMING.LOOP_INTERVAL_MS));
      continue;
    }

    // Smooth the depth reading
    driverState.smoothedDepth = smoothDepth(depth, driverState.smoothedDepth);

    // Make decision
    const decision = makeDecision(driverState.smoothedDepth, driverState);

    // Track decision history
    driverState.decisionHistory.push(decision);
    if (driverState.decisionHistory.length > 10) {
      driverState.decisionHistory.shift();
    }

    // Check for stuck condition (too many consecutive stops)
    if (decision === "STOP") {
      driverState.consecutiveStops++;
      if (driverState.consecutiveStops > 3) {
        // Try reversing
        console.log("[VisionDriver] Multiple stops, attempting reverse");
        await executeDecision("REVERSE");
        driverState.consecutiveStops = 0;
        driverState.turnCount++;
      }
    } else {
      driverState.consecutiveStops = 0;
    }

    // Track turns
    if (decision.startsWith("TURN")) {
      driverState.turnCount++;
    }

    // Track distance
    if (decision === "FORWARD" || decision === "FORWARD_SLOW") {
      driverState.totalDistance += TIMING.DRIVE_DURATION_MS * SPEEDS.CRUISE * 0.003; // rough cm estimate
    }

    // Execute
    const success = await executeDecision(decision);
    driverState.lastDecision = decision;

    if (!success) {
      console.error("[VisionDriver] Command failed");
    }

    // Log state
    console.log(
      `[VisionDriver] L:${driverState.smoothedDepth.left.toFixed(0)}% ` +
        `C:${driverState.smoothedDepth.center.toFixed(0)}% ` +
        `R:${driverState.smoothedDepth.right.toFixed(0)}% → ${decision}`
    );

    // Wait before next iteration
    await new Promise((r) => setTimeout(r, TIMING.LOOP_INTERVAL_MS));
  }

  // Cleanup
  const robot = getRobotClient();
  await robot.emergencyStop();
  stateMachine.transition({ type: "GOAL_REACHED" });
}

/**
 * Start vision-based autonomous driving
 */
export async function startVisionDrive(duration_s: number): Promise<string> {
  if (driverState?.running) {
    return "Vision driver already running";
  }

  // Check vision service
  const visionClient = getVisionClient();
  const available = await visionClient.isAvailable();
  if (!available) {
    return "Vision service not available";
  }

  // Initialize state
  driverState = {
    running: true,
    lastDecision: "STOP",
    consecutiveStops: 0,
    smoothedDepth: { left: 25, center: 14, right: 25 }, // baseline
    decisionHistory: [],
    startTime: Date.now(),
    totalDistance: 0,
    turnCount: 0,
  };

  // Start session logging
  const logger = getSessionLogger();
  logger.startSession("vision_drive");

  // Run driver loop (non-blocking)
  driverLoop(duration_s).then(() => {
    if (driverState) {
      const elapsed = (Date.now() - driverState.startTime) / 1000;
      console.log(
        `[VisionDriver] Completed: ${elapsed.toFixed(1)}s, ` +
          `${driverState.totalDistance.toFixed(0)}cm, ` +
          `${driverState.turnCount} turns`
      );
      logger.endSession();
      driverState = null;
    }
  });

  return `Vision driver started for ${duration_s}s`;
}

/**
 * Stop vision-based autonomous driving
 */
export async function stopVisionDrive(): Promise<string> {
  if (!driverState?.running) {
    return "Vision driver not running";
  }

  driverState.running = false;

  // Force stop motors
  const robot = getRobotClient();
  await robot.emergencyStop();

  const elapsed = (Date.now() - driverState.startTime) / 1000;
  const summary =
    `Vision driver stopped after ${elapsed.toFixed(1)}s, ` +
    `${driverState.totalDistance.toFixed(0)}cm traveled, ` +
    `${driverState.turnCount} turns`;

  return summary;
}

/**
 * Get current driver status
 */
export function getVisionDriverStatus(): {
  running: boolean;
  lastDecision: Decision | null;
  smoothedDepth: DepthZones | null;
  elapsed_s: number;
  totalDistance: number;
  turnCount: number;
} | null {
  if (!driverState) {
    return null;
  }

  return {
    running: driverState.running,
    lastDecision: driverState.lastDecision,
    smoothedDepth: driverState.smoothedDepth,
    elapsed_s: (Date.now() - driverState.startTime) / 1000,
    totalDistance: driverState.totalDistance,
    turnCount: driverState.turnCount,
  };
}
