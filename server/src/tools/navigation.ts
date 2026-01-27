/**
 * Navigation MCP Tools
 *
 * Waypoint management via Python vision service.
 * Python owns the database - these tools are thin wrappers around HTTP calls.
 */

import { z } from "zod";

const VISION_SERVICE_URL = process.env.VISION_SERVICE_URL || "http://localhost:8765";

interface Waypoint {
  name: string;
  x: number;
  y: number;
  heading: number;
  created_at?: string;
}

// ============================================================================
// save_waypoint
// ============================================================================

export const saveWaypointSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .describe("Name for this waypoint (e.g., 'kitchen_door', 'charging_station')"),
});

export async function saveWaypoint(params: z.infer<typeof saveWaypointSchema>): Promise<string> {
  try {
    const response = await fetch(`${VISION_SERVICE_URL}/waypoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: params.name }),
    });

    if (!response.ok) {
      const error = await response.text();
      return `Error saving waypoint: ${error}`;
    }

    const waypoint = (await response.json()) as Waypoint;
    return `Waypoint "${waypoint.name}" saved at position (${waypoint.x}, ${waypoint.y}) heading ${waypoint.heading}°`;
  } catch (error) {
    return `Error saving waypoint: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// list_waypoints
// ============================================================================

export const listWaypointsSchema = z.object({});

export async function listWaypoints(): Promise<string> {
  try {
    const response = await fetch(`${VISION_SERVICE_URL}/waypoints`);

    if (!response.ok) {
      const error = await response.text();
      return `Error listing waypoints: ${error}`;
    }

    const waypoints = (await response.json()) as Waypoint[];

    if (waypoints.length === 0) {
      return "No waypoints saved. Use save_waypoint to mark locations.";
    }

    let result = `Saved waypoints (${waypoints.length}):\n`;
    for (const wp of waypoints) {
      result += `  - "${wp.name}": (${wp.x}, ${wp.y}) heading ${wp.heading}°\n`;
    }

    return result;
  } catch (error) {
    return `Error listing waypoints: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// delete_waypoint
// ============================================================================

export const deleteWaypointSchema = z.object({
  name: z.string().min(1).describe("Name of the waypoint to delete"),
});

export async function deleteWaypoint(
  params: z.infer<typeof deleteWaypointSchema>
): Promise<string> {
  try {
    const response = await fetch(`${VISION_SERVICE_URL}/waypoint/${encodeURIComponent(params.name)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      if (response.status === 404) {
        return `Waypoint "${params.name}" not found.`;
      }
      const error = await response.text();
      return `Error deleting waypoint: ${error}`;
    }

    return `Waypoint "${params.name}" deleted.`;
  } catch (error) {
    return `Error deleting waypoint: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// get_position
// ============================================================================

export const getPositionSchema = z.object({});

export async function getPosition(): Promise<string> {
  try {
    const response = await fetch(`${VISION_SERVICE_URL}/position`);

    if (!response.ok) {
      const error = await response.text();
      return `Error getting position: ${error}`;
    }

    const pos = (await response.json()) as { x: number; y: number; heading: number };
    return `Current position: (${pos.x}, ${pos.y}) heading ${pos.heading}°`;
  } catch (error) {
    return `Error getting position: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// reset_position
// ============================================================================

export const resetPositionSchema = z.object({});

export async function resetPosition(): Promise<string> {
  try {
    const response = await fetch(`${VISION_SERVICE_URL}/position/reset`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.text();
      return `Error resetting position: ${error}`;
    }

    return "Position reset to origin (0, 0, 0).";
  } catch (error) {
    return `Error resetting position: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

// ============================================================================
// Export tool definitions
// ============================================================================

export const navigationTools = {
  save_waypoint: {
    name: "save_waypoint",
    description:
      "Mark the current position as a named waypoint for later navigation. Waypoints persist across sessions.",
    schema: saveWaypointSchema,
    handler: saveWaypoint,
  },
  list_waypoints: {
    name: "list_waypoints",
    description: "List all saved waypoints with their positions.",
    schema: listWaypointsSchema,
    handler: listWaypoints,
  },
  delete_waypoint: {
    name: "delete_waypoint",
    description: "Delete a saved waypoint by name.",
    schema: deleteWaypointSchema,
    handler: deleteWaypoint,
  },
  get_position: {
    name: "get_position",
    description:
      "Quick check of current estimated position and heading. Lightweight alternative to get_status.",
    schema: getPositionSchema,
    handler: getPosition,
  },
  reset_position: {
    name: "reset_position",
    description:
      "Reset the estimated position to origin (0,0,0). Use after manually repositioning the robot to a known starting point.",
    schema: resetPositionSchema,
    handler: resetPosition,
  },
};
