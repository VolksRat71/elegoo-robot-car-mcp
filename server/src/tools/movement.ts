import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";

export const driveSchema = z.object({
  direction: z
    .enum(["forward", "backward", "left", "right", "stop"])
    .describe("Direction to move the robot"),
  speed: z.number().min(0).max(100).default(50).describe("Speed as percentage (0-100)"),
  duration_ms: z
    .number()
    .min(0)
    .max(10000)
    .optional()
    .describe("Duration in milliseconds. If omitted, robot moves until stop command."),
  check_obstacle: z
    .boolean()
    .default(false)
    .describe("Check ultrasonic sensor before moving forward. Stops if obstacle detected."),
});

export const turnSchema = z.object({
  degrees: z
    .number()
    .min(-180)
    .max(180)
    .describe("Degrees to turn. Positive = clockwise, negative = counter-clockwise."),
  speed: z.number().min(0).max(100).default(50).describe("Turn speed as percentage (0-100)"),
});

export async function drive(params: z.infer<typeof driveSchema>): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    // If check_obstacle is enabled and moving forward, check distance first
    if (params.check_obstacle && params.direction === "forward") {
      const distResponse = await robot.getDistance();
      if (distResponse.success && distResponse.data) {
        const data = distResponse.data as { distance: number };
        if (data.distance > 0 && data.distance < 20) {
          return `BLOCKED: Obstacle detected ${data.distance}cm ahead. Robot stopped for safety.`;
        }
      }
    }

    const response = await robot.drive(params.direction, params.speed, params.duration_ms);

    if (!response.success) {
      return `Failed to drive: ${response.error || "Unknown error"}`;
    }

    // Update position estimate if duration was specified
    if (params.duration_ms && params.direction !== "stop") {
      mapStore.estimateMovement(params.direction, params.speed, params.duration_ms);
      const pos = mapStore.getPosition();
      const obstacleNote = params.check_obstacle ? " (obstacle check enabled)" : "";
      return `Robot moving ${params.direction} at ${params.speed}% speed for ${params.duration_ms}ms${obstacleNote}. Estimated position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) heading ${pos.heading.toFixed(1)}°`;
    }

    if (params.direction === "stop") {
      return "Robot stopped.";
    }

    return `Robot moving ${params.direction} at ${params.speed}% speed. Send stop command to halt.`;
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

export const movementTools = {
  drive: {
    name: "drive",
    description:
      "Move the robot in a direction. Use 'stop' to halt. Set check_obstacle=true to check ultrasonic before moving forward.",
    schema: driveSchema,
    handler: drive,
  },
  turn: {
    name: "turn",
    description:
      "Turn the robot in place by a specified number of degrees. Positive = clockwise, negative = counter-clockwise.",
    schema: turnSchema,
    handler: turn,
  },
};
