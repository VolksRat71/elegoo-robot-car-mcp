import { z } from "zod";
import { getMapStore } from "../map-store.js";

export const saveWaypointSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .describe("Name for this waypoint (e.g., 'kitchen_door', 'charging_station')"),
});

export async function saveWaypoint(params: z.infer<typeof saveWaypointSchema>): Promise<string> {
  const mapStore = getMapStore();

  try {
    const waypoint = mapStore.saveWaypoint(params.name);
    return `Waypoint "${params.name}" saved at position (${waypoint.x.toFixed(1)}, ${waypoint.y.toFixed(1)}) heading ${waypoint.heading.toFixed(1)}°`;
  } catch (error) {
    return `Error saving waypoint: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function listWaypoints(): Promise<string> {
  const mapStore = getMapStore();

  try {
    const waypoints = mapStore.listWaypoints();

    if (waypoints.length === 0) {
      return "No waypoints saved. Use save_waypoint to mark locations.";
    }

    let result = `Saved waypoints (${waypoints.length}):\n`;
    for (const wp of waypoints) {
      result += `  - "${wp.name}": (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) heading ${wp.heading.toFixed(1)}°\n`;
    }

    return result;
  } catch (error) {
    return `Error listing waypoints: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

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
    schema: z.object({}),
    handler: listWaypoints,
  },
};

// =============================================================================
// GATED TOOLS - Disabled until VL53L1X ToF sensor arrives
// =============================================================================
// The following tools are disabled because they rely on accurate distance
// sensing that the HC-SR04 ultrasonic cannot reliably provide:
//
// - scan_surroundings: Servo pan scan with distance readings
//   Issue: Ultrasonic readings are too noisy/unreliable for mapping
//
// - navigate_to: Dead reckoning navigation to waypoints
//   Issue: Without reliable scan data, path planning is inaccurate
//
// These will be re-enabled when VL53L1X ToF sensor integration is complete.
// =============================================================================
