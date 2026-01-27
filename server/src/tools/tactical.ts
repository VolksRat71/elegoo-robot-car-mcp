/**
 * Tactical MCP Tools
 *
 * High-level tools for LLM interaction:
 * - observe() - Get current WorldState
 * - explore() - Autonomous exploration with obstacle avoidance
 * - stop() - Immediate halt
 * - list_places() - List known places (stub for now)
 */

import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";
import {
  buildWorldState,
  formatWorldState,
  type WorldState,
} from "../autonomy/world-state.js";
import { getAutonomyStateMachine } from "../autonomy/state-machine.js";
import { getSessionLogger } from "../autonomy/logger.js";

// ============================================================================
// observe() - Get current WorldState
// ============================================================================

export const observeSchema = z.object({
  mode: z
    .enum(["quick", "burst"])
    .default("quick")
    .describe("Mode: 'quick' for geometry+health only, 'burst' for full state + camera"),
});

export async function observe(
  params: z.infer<typeof observeSchema>
): Promise<string> {
  const logger = getSessionLogger();

  try {
    const worldState = await buildWorldState();

    // Log the WorldState
    logger.logWorldState(worldState);

    // Format for LLM consumption
    const formatted = formatWorldState(worldState);

    if (params.mode === "burst") {
      // In burst mode, we could also capture a camera image
      // For now, just return the full WorldState as JSON
      return `${formatted}\n\n[Full WorldState JSON]\n${JSON.stringify(worldState, null, 2)}`;
    }

    return formatted;
  } catch (error) {
    return `Error observing: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// explore() - Autonomous exploration
// ============================================================================

export const exploreSchema = z.object({
  duration_s: z
    .number()
    .min(5)
    .max(300)
    .default(30)
    .describe("Duration to explore in seconds (5-300)"),
});

export async function explore(
  params: z.infer<typeof exploreSchema>
): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();
  const stateMachine = getAutonomyStateMachine();
  const logger = getSessionLogger();

  // Start exploration
  stateMachine.transition({ type: "GOAL_RECEIVED" });
  stateMachine.setLastAction(`explore(${params.duration_s}s)`);

  const startTime = Date.now();
  const endTime = startTime + params.duration_s * 1000;

  let obstaclesEncountered = 0;
  let distanceTraveled = 0;
  let turnsExecuted = 0;

  logger.logAction(
    "explore",
    { duration_s: params.duration_s },
    { status: "started" }
  );

  try {
    // Pre-laser exploration: simple random walk with obstacle avoidance
    while (Date.now() < endTime && !stateMachine.isBlocked()) {
      // Check for obstacles
      const distResult = await robot.getDistance();
      let distance = 999;
      if (distResult.success && distResult.data) {
        distance = (distResult.data as { distance: number }).distance;
      }

      // Log world state periodically
      const worldState = await buildWorldState();
      logger.logWorldState(worldState);

      if (distance > 0 && distance < 25) {
        // Obstacle detected - stop and turn
        obstaclesEncountered++;
        stateMachine.transition({ type: "OBSTACLE_DETECTED" });

        await robot.emergencyStop();

        // Turn a random direction (60-120 degrees)
        const turnDegrees = (Math.random() > 0.5 ? 1 : -1) * (60 + Math.random() * 60);
        await robot.turn(turnDegrees, 50);
        turnsExecuted++;

        // Update heading estimate
        const pos = mapStore.getPosition();
        mapStore.updatePosition(pos.x, pos.y, (pos.heading + turnDegrees + 360) % 360);

        // Clear obstacle if we successfully turned
        stateMachine.clearObstacles();
      } else {
        // Path clear - move forward for 1 second
        await robot.drive("forward", 40, 1000);
        distanceTraveled += 12; // Rough estimate: 12cm at 40% speed for 1s

        // Update position estimate
        mapStore.estimateMovement("forward", 40, 1000);
      }

      // Small delay between iterations
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Stop and return to idle
    await robot.emergencyStop();
    stateMachine.transition({ type: "GOAL_REACHED" });

    const duration = (Date.now() - startTime) / 1000;
    const finalWorldState = await buildWorldState();

    const result = {
      status: stateMachine.isBlocked() ? "stuck" : "completed",
      duration_s: duration,
      obstacles_encountered: obstaclesEncountered,
      turns_executed: turnsExecuted,
      estimated_distance_cm: distanceTraveled,
      final_position: mapStore.getPosition(),
      final_state: finalWorldState.autonomy_state,
    };

    logger.logAction("explore", { duration_s: params.duration_s }, result);

    return `Exploration ${result.status}:
- Duration: ${duration.toFixed(1)}s
- Obstacles encountered: ${obstaclesEncountered}
- Turns executed: ${turnsExecuted}
- Estimated distance: ${distanceTraveled}cm
- Final position: (${result.final_position.x.toFixed(1)}, ${result.final_position.y.toFixed(1)}) heading ${result.final_position.heading.toFixed(1)}°
- Final state: ${result.final_state}`;
  } catch (error) {
    // Emergency stop on error
    await robot.emergencyStop();
    stateMachine.transition({ type: "MANUAL_STOP" });

    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.logAction(
      "explore",
      { duration_s: params.duration_s },
      { status: "error", error: errorMsg }
    );

    return `Exploration failed: ${errorMsg}. Robot stopped.`;
  }
}

// ============================================================================
// stop() - Immediate halt
// ============================================================================

export const stopSchema = z.object({});

export async function stop(): Promise<string> {
  const robot = getRobotClient();
  const stateMachine = getAutonomyStateMachine();
  const logger = getSessionLogger();

  try {
    await robot.emergencyStop();
    stateMachine.transition({ type: "MANUAL_STOP" });
    stateMachine.setLastAction("stop()");

    logger.logAction("stop", {}, { status: "success" });

    return "Robot stopped. All motors halted. State: IDLE";
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.logAction("stop", {}, { status: "error", error: errorMsg });
    return `Stop command sent but may have failed: ${errorMsg}`;
  }
}

// ============================================================================
// list_places() - List known places (stub)
// ============================================================================

export const listPlacesSchema = z.object({});

export async function listPlaces(): Promise<string> {
  // Pre-laser: Return empty list
  // Post-laser: Query place graph from SQLite
  return `[Place Graph - Pre-laser stub]
No places discovered yet. Place graph requires VL53L1X ToF sensor for reliable place signatures.

Current capabilities:
- Waypoints (dead reckoning): Use list_waypoints tool
- Occupancy grid: Basic obstacle mapping

Future (post-ToF):
- Place nodes with ToF fingerprints
- Place edges with success rates
- Loop closure detection`;
}

// ============================================================================
// Export tool definitions
// ============================================================================

export const tacticalTools = {
  observe: {
    name: "observe",
    description:
      "Get the current WorldState - robot's view of its environment, state, and health. Use 'quick' mode for basic geometry or 'burst' for full details.",
    schema: observeSchema,
    handler: observe,
  },
  explore: {
    name: "explore",
    description:
      "Start autonomous exploration. Robot will wander, avoid obstacles, and build a map. Returns summary when complete or stuck.",
    schema: exploreSchema,
    handler: explore,
  },
  tactical_stop: {
    name: "tactical_stop",
    description:
      "Immediately stop all robot movement and cancel any ongoing exploration. Sets autonomy state to IDLE.",
    schema: stopSchema,
    handler: stop,
  },
  list_places: {
    name: "list_places",
    description:
      "List all known places in the place graph. Currently returns empty (requires VL53L1X ToF sensor).",
    schema: listPlacesSchema,
    handler: listPlaces,
  },
};
