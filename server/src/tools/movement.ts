import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";

export const driveSchema = z.object({
  direction: z
    .enum(["forward", "backward", "left", "right", "stop"])
    .describe("Direction to move the robot"),
  speed: z
    .number()
    .min(0)
    .max(100)
    .default(50)
    .describe("Speed as percentage (0-100)"),
  duration_ms: z
    .number()
    .min(0)
    .max(10000)
    .optional()
    .describe("Duration in milliseconds. If omitted, robot moves until stop command."),
});

export const safeDriveSchema = z.object({
  direction: z
    .enum(["forward", "backward", "left", "right", "stop"])
    .describe("Direction to move the robot"),
  speed: z
    .number()
    .min(0)
    .max(100)
    .default(50)
    .describe("Speed as percentage (0-100)"),
  check_obstacles: z
    .boolean()
    .default(false)
    .describe("Enable obstacle checking (currently experimental - sensor may not work reliably)"),
});

export const turnSchema = z.object({
  degrees: z
    .number()
    .min(-180)
    .max(180)
    .describe("Degrees to turn. Positive = clockwise, negative = counter-clockwise."),
  speed: z
    .number()
    .min(0)
    .max(100)
    .default(50)
    .describe("Turn speed as percentage (0-100)"),
});

export async function drive(
  params: z.infer<typeof driveSchema>
): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    const response = await robot.drive(
      params.direction,
      params.speed,
      params.duration_ms
    );

    if (!response.success) {
      return `Failed to drive: ${response.error || "Unknown error"}`;
    }

    // Update position estimate if duration was specified
    if (params.duration_ms && params.direction !== "stop") {
      mapStore.estimateMovement(params.direction, params.speed, params.duration_ms);
      const pos = mapStore.getPosition();
      return `Robot moving ${params.direction} at ${params.speed}% speed for ${params.duration_ms}ms. Estimated position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) heading ${pos.heading.toFixed(1)}°`;
    }

    if (params.direction === "stop") {
      return "Robot stopped.";
    }

    return `Robot moving ${params.direction} at ${params.speed}% speed. Send stop command to halt.`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function safeDrive(
  params: z.infer<typeof safeDriveSchema>
): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.safeDrive(
      params.direction,
      params.speed,
      params.check_obstacles
    );

    if (!response.success) {
      const data = response.data as { blocked?: boolean };
      if (data?.blocked) {
        return `BLOCKED: ${response.error}`;
      }
      return `Failed to drive: ${response.error || "Unknown error"}`;
    }

    if (params.direction === "stop") {
      return "Robot stopped.";
    }

    const obstacleNote = params.check_obstacles ? " (obstacle checking enabled)" : "";
    return `Robot moving ${params.direction} at ${params.speed}% speed${obstacleNote}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function turn(params: z.infer<typeof turnSchema>): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    const response = await robot.turn(params.degrees, params.speed);

    if (!response.success) {
      return `Failed to turn: ${response.error || "Unknown error"}`;
    }

    // Update heading estimate
    const currentPos = mapStore.getPosition();
    mapStore.updatePosition(
      currentPos.x,
      currentPos.y,
      (currentPos.heading + params.degrees + 360) % 360
    );

    const direction = params.degrees > 0 ? "clockwise" : "counter-clockwise";
    const pos = mapStore.getPosition();
    return `Robot turned ${Math.abs(params.degrees)}° ${direction}. New heading: ${pos.heading.toFixed(1)}°`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function emergencyStop(): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.emergencyStop();

    if (!response.success) {
      return `Emergency stop may have failed: ${response.error || "Unknown error"}`;
    }

    return "EMERGENCY STOP executed. All motors halted immediately.";
  } catch (error) {
    // Even if communication fails, try to convey urgency
    return `Emergency stop command sent but confirmation failed: ${error instanceof Error ? error.message : "Unknown error"}. Robot may have stopped.`;
  }
}

export const movementTools = {
  drive: {
    name: "drive",
    description:
      "Move the robot in a direction. Use 'stop' to halt movement. If duration_ms is specified, robot moves for that duration then stops automatically.",
    schema: driveSchema,
    handler: drive,
  },
  safe_drive: {
    name: "safe_drive",
    description:
      "Move the robot with automatic obstacle detection. Checks ultrasonic sensor before moving forward and stops if obstacle is closer than min_distance. RECOMMENDED over regular drive for forward movement.",
    schema: safeDriveSchema,
    handler: safeDrive,
  },
  turn: {
    name: "turn",
    description:
      "Turn the robot in place by a specified number of degrees. Positive = clockwise, negative = counter-clockwise.",
    schema: turnSchema,
    handler: turn,
  },
  emergency_stop: {
    name: "emergency_stop",
    description:
      "Immediately stop all robot movement. Use in case of emergency or unexpected behavior.",
    schema: z.object({}),
    handler: emergencyStop,
  },
};
