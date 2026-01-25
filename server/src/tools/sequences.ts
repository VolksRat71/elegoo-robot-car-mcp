import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";
import { captureImage } from "./vision.js";

// Action schemas for sequence steps
const driveActionSchema = z.object({
  action: z.literal("drive"),
  direction: z.enum(["forward", "backward", "left", "right", "stop"]),
  speed: z.number().min(0).max(100).default(50),
  duration_ms: z.number().min(0).max(10000),
});

const turnActionSchema = z.object({
  action: z.literal("turn"),
  degrees: z.number().min(-360).max(360),
  speed: z.number().min(0).max(100).default(40),
});

const lookActionSchema = z.object({
  action: z.literal("look"),
  angle: z.number().min(0).max(180),
});

const captureActionSchema = z.object({
  action: z.literal("capture"),
});

const waitActionSchema = z.object({
  action: z.literal("wait"),
  duration_ms: z.number().min(0).max(5000),
});

const saveLocationActionSchema = z.object({
  action: z.literal("save_location"),
  name: z.string().min(1).max(50),
});

const actionSchema = z.discriminatedUnion("action", [
  driveActionSchema,
  turnActionSchema,
  lookActionSchema,
  captureActionSchema,
  waitActionSchema,
  saveLocationActionSchema,
]);

export const executeSequenceSchema = z.object({
  actions: z
    .array(actionSchema)
    .min(1)
    .max(20)
    .describe("List of actions to execute in order"),
  capture_at_end: z
    .boolean()
    .default(true)
    .describe("Capture an image after completing the sequence"),
  stop_on_error: z
    .boolean()
    .default(true)
    .describe("Stop executing if any action fails"),
});

type Action = z.infer<typeof actionSchema>;
type SequenceResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
};

async function executeAction(action: Action): Promise<{ success: boolean; message: string; duration_ms: number }> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    switch (action.action) {
      case "drive": {
        const response = await robot.drive(action.direction, action.speed, action.duration_ms);
        if (!response.success) {
          return { success: false, message: `Drive failed: ${response.error}`, duration_ms: 0 };
        }
        if (action.duration_ms && action.direction !== "stop") {
          mapStore.estimateMovement(action.direction, action.speed, action.duration_ms);
        }
        // Wait for drive to complete
        await new Promise(resolve => setTimeout(resolve, action.duration_ms));
        return { success: true, message: `Drove ${action.direction} for ${action.duration_ms}ms`, duration_ms: action.duration_ms };
      }

      case "turn": {
        // Use drive left/right for more reliable turning
        const direction = action.degrees > 0 ? "right" : "left";
        const duration = Math.abs(action.degrees) * 11; // ~11ms per degree at speed 40
        const response = await robot.drive(direction, action.speed, duration);
        if (!response.success) {
          return { success: false, message: `Turn failed: ${response.error}`, duration_ms: 0 };
        }
        const currentPos = mapStore.getPosition();
        mapStore.updatePosition(
          currentPos.x,
          currentPos.y,
          (currentPos.heading + action.degrees + 360) % 360
        );
        // Wait for turn to complete
        await new Promise(resolve => setTimeout(resolve, duration));
        return { success: true, message: `Turned ${action.degrees}°`, duration_ms: duration };
      }

      case "look": {
        const response = await robot.look(action.angle);
        if (!response.success) {
          return { success: false, message: `Look failed: ${response.error}`, duration_ms: 0 };
        }
        // Small wait for servo to move
        await new Promise(resolve => setTimeout(resolve, 300));
        return { success: true, message: `Camera at ${action.angle}°`, duration_ms: 300 };
      }

      case "capture": {
        return { success: true, message: "Image captured (see end of sequence)", duration_ms: 0 };
      }

      case "wait": {
        await new Promise(resolve => setTimeout(resolve, action.duration_ms));
        return { success: true, message: `Waited ${action.duration_ms}ms`, duration_ms: action.duration_ms };
      }

      case "save_location": {
        mapStore.saveWaypoint(action.name);
        const pos = mapStore.getPosition();
        return { success: true, message: `Saved "${action.name}" at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`, duration_ms: 0 };
      }

      default:
        return { success: false, message: "Unknown action type", duration_ms: 0 };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Unknown error", duration_ms: 0 };
  }
}

export async function executeSequence(
  params: z.infer<typeof executeSequenceSchema>
): Promise<SequenceResult> {
  const mapStore = getMapStore();
  const results: string[] = [];
  let capturedImage: { data: string; mimeType: string } | null = null;
  let hasMidSequenceCapture = false;

  results.push(`Executing ${params.actions.length} actions...`);
  results.push("");

  for (let i = 0; i < params.actions.length; i++) {
    const action = params.actions[i];
    const stepNum = i + 1;

    // Handle mid-sequence captures
    if (action.action === "capture") {
      hasMidSequenceCapture = true;
      const imgResult = await captureImage();
      const imgContent = imgResult.content.find(c => c.type === "image");
      if (imgContent && imgContent.type === "image") {
        capturedImage = { data: imgContent.data, mimeType: imgContent.mimeType };
      }
      results.push(`[${stepNum}] ✓ Captured image`);
      continue;
    }

    const result = await executeAction(action);

    if (result.success) {
      results.push(`[${stepNum}] ✓ ${result.message}`);
    } else {
      results.push(`[${stepNum}] ✗ ${result.message}`);
      if (params.stop_on_error) {
        results.push("");
        results.push(`Sequence stopped at step ${stepNum} due to error.`);
        break;
      }
    }

    // Small changeover delay between actions for stability
    // (action durations are already waited inside executeAction)
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  // Final state
  const pos = mapStore.getPosition();
  results.push("");
  results.push(`Final position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) heading ${pos.heading.toFixed(1)}°`);

  // Capture at end if requested and no mid-sequence capture
  if (params.capture_at_end && !hasMidSequenceCapture) {
    const imgResult = await captureImage();
    const imgContent = imgResult.content.find(c => c.type === "image");
    if (imgContent && imgContent.type === "image") {
      capturedImage = { data: imgContent.data, mimeType: imgContent.mimeType };
      results.push("Final image captured.");
    }
  }

  const content: SequenceResult["content"] = [
    { type: "text", text: results.join("\n") },
  ];

  if (capturedImage) {
    content.push({
      type: "image",
      data: capturedImage.data,
      mimeType: capturedImage.mimeType,
    });
  }

  return { content };
}

// Quick navigation patterns
export const quickPatternSchema = z.object({
  pattern: z
    .enum(["look_around", "backup_and_turn", "square", "explore_forward"])
    .describe("Predefined movement pattern to execute"),
  speed: z.number().min(0).max(100).default(40).describe("Speed for movements"),
});

export async function executePattern(
  params: z.infer<typeof quickPatternSchema>
): Promise<SequenceResult> {
  const patterns: Record<string, z.infer<typeof executeSequenceSchema>["actions"]> = {
    look_around: [
      { action: "look", angle: 0 },
      { action: "wait", duration_ms: 300 },
      { action: "capture" },
      { action: "look", angle: 90 },
      { action: "wait", duration_ms: 300 },
      { action: "capture" },
      { action: "look", angle: 180 },
      { action: "wait", duration_ms: 300 },
      { action: "capture" },
      { action: "look", angle: 90 },
    ],
    backup_and_turn: [
      { action: "drive", direction: "backward", speed: params.speed, duration_ms: 800 },
      { action: "turn", degrees: 90, speed: params.speed },
      { action: "capture" },
    ],
    square: [
      { action: "drive", direction: "forward", speed: params.speed, duration_ms: 1000 },
      { action: "turn", degrees: 90, speed: params.speed },
      { action: "drive", direction: "forward", speed: params.speed, duration_ms: 1000 },
      { action: "turn", degrees: 90, speed: params.speed },
      { action: "drive", direction: "forward", speed: params.speed, duration_ms: 1000 },
      { action: "turn", degrees: 90, speed: params.speed },
      { action: "drive", direction: "forward", speed: params.speed, duration_ms: 1000 },
      { action: "turn", degrees: 90, speed: params.speed },
      { action: "capture" },
    ],
    explore_forward: [
      { action: "look", angle: 90 },
      { action: "capture" },
      { action: "drive", direction: "forward", speed: params.speed, duration_ms: 1500 },
      { action: "capture" },
    ],
  };

  const actions = patterns[params.pattern];
  if (!actions) {
    return {
      content: [{ type: "text", text: `Unknown pattern: ${params.pattern}` }],
    };
  }

  return executeSequence({
    actions,
    capture_at_end: false, // Patterns handle their own captures
    stop_on_error: true,
  });
}

export const sequenceTools = {
  execute_sequence: {
    name: "execute_sequence",
    description: `Execute a sequence of robot actions in order and return the final state with an image.

Available actions:
- drive: {action: "drive", direction: "forward"|"backward"|"left"|"right", speed: 0-100, duration_ms: number}
- turn: {action: "turn", degrees: -360 to 360, speed: 0-100}
- look: {action: "look", angle: 0-180}
- capture: {action: "capture"} - take a photo mid-sequence
- wait: {action: "wait", duration_ms: number}
- save_location: {action: "save_location", name: "string"}

Example: Turn right, move forward, and take a photo:
[{"action":"turn","degrees":90},{"action":"drive","direction":"forward","speed":40,"duration_ms":1000},{"action":"capture"}]`,
    schema: executeSequenceSchema,
    handler: executeSequence,
  },
  execute_pattern: {
    name: "execute_pattern",
    description: `Execute a predefined movement pattern.

Available patterns:
- look_around: Pan camera left, center, right with captures
- backup_and_turn: Back up and turn 90° right
- square: Drive in a square pattern
- explore_forward: Look ahead, capture, move forward, capture`,
    schema: quickPatternSchema,
    handler: executePattern,
  },
};
