/**
 * Claude Copilot MCP Tools
 *
 * Tools for Claude to act as a copilot during autonomous driving:
 * - get_journey_montage() - View recent drive snapshots
 * - set_nudge() - Bias the autonomous driver's decisions
 * - get_nudges() - Check current nudge settings
 * - clear_nudges() - Reset nudges to default
 */

import { z } from "zod";
import { getVisionClient } from "../vision-client.js";

// ============================================================================
// get_journey_montage() - View recent drive snapshots
// ============================================================================

export const getJourneyMontageSchema = z.object({
  count: z
    .number()
    .min(1)
    .max(12)
    .default(6)
    .describe("Number of recent snapshots to include in the montage (1-12)"),
});

export async function getJourneyMontage(
  params: z.infer<typeof getJourneyMontageSchema>
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
  const vision = getVisionClient();

  try {
    const result = await vision.getMontage(params.count);

    if (!result.success || !result.image_base64) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get montage: ${result.error || "No snapshots available"}`,
          },
        ],
      };
    }

    // Return both the image and metadata
    return {
      content: [
        {
          type: "text",
          text: `Journey Montage (${result.snapshot_count} snapshots)\nFiles: ${result.snapshots?.join(", ")}\nSize: ${result.width}x${result.height}`,
        },
        {
          type: "image",
          data: result.image_base64,
          mimeType: "image/jpeg",
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting montage: ${error instanceof Error ? error.message : "Unknown"}`,
        },
      ],
    };
  }
}

// ============================================================================
// set_nudge() - Bias the autonomous driver's decisions
// ============================================================================

export const setNudgeSchema = z.object({
  active: z
    .boolean()
    .optional()
    .describe("Enable or disable the nudge system"),
  goal: z
    .string()
    .optional()
    .describe("High-level goal description (e.g., 'find the kitchen', 'explore the bedroom')"),
  prefer_direction: z
    .enum(["left", "right"])
    .optional()
    .describe("Bias the robot to prefer turning left or right"),
  bias_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("How strongly to apply the directional bias (0.0-1.0, default 0.3)"),
  look_for: z
    .array(z.string())
    .optional()
    .describe("Objects to seek (e.g., ['chair', 'table', 'couch'])"),
  avoid: z
    .array(z.string())
    .optional()
    .describe("Objects to avoid (e.g., ['person', 'dog'])"),
  notes: z
    .string()
    .optional()
    .describe("Freeform notes about the current navigation strategy"),
});

export async function setNudge(params: z.infer<typeof setNudgeSchema>): Promise<string> {
  const vision = getVisionClient();

  try {
    const result = await vision.setNudge(params);

    if (!result) {
      return "Failed to set nudge - vision service may be unavailable";
    }

    const parts = [
      `Nudge updated:`,
      `- Active: ${result.active}`,
      `- Goal: ${result.goal || "(none)"}`,
      `- Prefer direction: ${result.prefer_direction || "(none)"}`,
      `- Bias strength: ${result.bias_strength}`,
      `- Look for: ${result.look_for.length > 0 ? result.look_for.join(", ") : "(none)"}`,
      `- Avoid: ${result.avoid.length > 0 ? result.avoid.join(", ") : "(none)"}`,
    ];

    if (result.notes) {
      parts.push(`- Notes: ${result.notes}`);
    }

    return parts.join("\n");
  } catch (error) {
    return `Error setting nudge: ${error instanceof Error ? error.message : "Unknown"}`;
  }
}

// ============================================================================
// get_nudges() - Check current nudge settings
// ============================================================================

export const getNudgesSchema = z.object({});

export async function getNudges(): Promise<string> {
  const vision = getVisionClient();

  try {
    const result = await vision.getNudges();

    if (!result) {
      return "Failed to get nudges - vision service may be unavailable";
    }

    const parts = [
      `Current nudge settings:`,
      `- Active: ${result.active}`,
      `- Goal: ${result.goal || "(none)"}`,
      `- Prefer direction: ${result.prefer_direction || "(none)"}`,
      `- Bias strength: ${result.bias_strength}`,
      `- Look for: ${result.look_for.length > 0 ? result.look_for.join(", ") : "(none)"}`,
      `- Avoid: ${result.avoid.length > 0 ? result.avoid.join(", ") : "(none)"}`,
    ];

    if (result.notes) {
      parts.push(`- Notes: ${result.notes}`);
    }

    return parts.join("\n");
  } catch (error) {
    return `Error getting nudges: ${error instanceof Error ? error.message : "Unknown"}`;
  }
}

// ============================================================================
// clear_nudges() - Reset nudges to default
// ============================================================================

export const clearNudgesSchema = z.object({});

export async function clearNudges(): Promise<string> {
  const vision = getVisionClient();

  try {
    const result = await vision.clearNudges();

    if (!result) {
      return "Failed to clear nudges - vision service may be unavailable";
    }

    return "Nudges cleared. Driver will use default navigation behavior.";
  } catch (error) {
    return `Error clearing nudges: ${error instanceof Error ? error.message : "Unknown"}`;
  }
}

// ============================================================================
// Export tool definitions
// ============================================================================

export const copilotTools = {
  get_journey_montage: {
    name: "get_journey_montage",
    description:
      "Get a montage image of recent drive snapshots to see where the robot has been. Use this periodically during autonomous driving to review the robot's journey and decide if nudges are needed.",
    schema: getJourneyMontageSchema,
    handler: getJourneyMontage,
  },
  set_nudge: {
    name: "set_nudge",
    description:
      "Set navigation nudges to bias the autonomous driver's decisions. Use this to guide the robot toward goals (e.g., 'find the kitchen'), prefer certain directions, or specify objects to seek or avoid. The driver hot-reloads these settings.",
    schema: setNudgeSchema,
    handler: setNudge,
  },
  get_nudges: {
    name: "get_nudges",
    description: "Get the current nudge settings to see how the autonomous driver is being biased.",
    schema: getNudgesSchema,
    handler: getNudges,
  },
  clear_nudges: {
    name: "clear_nudges",
    description:
      "Reset all nudges to default. The autonomous driver will return to unbiased navigation behavior.",
    schema: clearNudgesSchema,
    handler: clearNudges,
  },
};
