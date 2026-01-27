import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";

export async function getStatus(): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  const connectionStatus = robot.getConnectionStatus();
  const position = mapStore.getPosition();

  let result = "Robot Status:\n";
  result += `  Connection: ${connectionStatus.connected ? "Connected" : "Disconnected"}\n`;

  if (!connectionStatus.connected) {
    result += "  (Cannot retrieve live status - robot not connected)\n";
    result += `\nEstimated Position: (${position.x.toFixed(1)}, ${position.y.toFixed(1)}) heading ${position.heading.toFixed(1)}°\n`;
    return result;
  }

  try {
    const response = await robot.getStatus();

    if (response.success && response.data) {
      const data = response.data as {
        battery?: number;
        wifiSignal?: number;
        mode?: string;
        uptime?: number;
      };

      if (data.battery !== undefined) {
        const batteryBar = "█".repeat(Math.floor(data.battery / 10));
        const batteryEmpty = "░".repeat(10 - Math.floor(data.battery / 10));
        result += `  Battery: [${batteryBar}${batteryEmpty}] ${data.battery}%\n`;
      }

      if (data.wifiSignal !== undefined) {
        result += `  WiFi Signal: ${data.wifiSignal} dBm\n`;
      }

      if (data.mode) {
        result += `  Mode: ${data.mode}\n`;
      }

      if (data.uptime !== undefined) {
        const minutes = Math.floor(data.uptime / 60);
        const seconds = data.uptime % 60;
        result += `  Uptime: ${minutes}m ${seconds}s\n`;
      }
    }
  } catch (error) {
    result += `  (Error fetching live status: ${error instanceof Error ? error.message : "Unknown"})\n`;
  }

  result += `\nPosition (estimated): (${position.x.toFixed(1)}, ${position.y.toFixed(1)}) heading ${position.heading.toFixed(1)}°`;

  return result;
}

export async function resetPosition(): Promise<string> {
  const mapStore = getMapStore();

  try {
    mapStore.updatePosition(0, 0, 0);
    return "Position reset to origin (0, 0) with heading 0°. Use this when you manually place the robot at a known starting position.";
  } catch (error) {
    return `Error resetting position: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function clearMap(): Promise<string> {
  const mapStore = getMapStore();

  try {
    mapStore.clearMap();
    return "Map cleared. All scan readings and occupancy data deleted. Waypoints preserved. Position reset to origin.";
  } catch (error) {
    return `Error clearing map: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function getPosition(): Promise<string> {
  const mapStore = getMapStore();
  const pos = mapStore.getPosition();
  return `Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) heading ${pos.heading.toFixed(1)}°`;
}

export const deleteWaypointSchema = z.object({
  name: z.string().min(1).describe("Name of the waypoint to delete"),
});

export async function deleteWaypoint(
  params: z.infer<typeof deleteWaypointSchema>
): Promise<string> {
  const mapStore = getMapStore();

  const deleted = mapStore.deleteWaypoint(params.name);
  if (deleted) {
    return `Waypoint "${params.name}" deleted.`;
  }
  return `Waypoint "${params.name}" not found.`;
}

export const systemTools = {
  get_status: {
    name: "get_status",
    description:
      "Get robot status including battery level, WiFi signal, current mode, and estimated position.",
    schema: z.object({}),
    handler: getStatus,
  },
  get_position: {
    name: "get_position",
    description:
      "Quick check of current estimated position and heading. Lightweight alternative to get_status.",
    schema: z.object({}),
    handler: getPosition,
  },
  reset_position: {
    name: "reset_position",
    description:
      "Reset the estimated position to origin (0,0,0). Use after manually repositioning the robot to a known starting point.",
    schema: z.object({}),
    handler: resetPosition,
  },
  clear_map: {
    name: "clear_map",
    description:
      "Clear all mapping data (scan readings and occupancy grid). Waypoints are preserved. Position is reset to origin.",
    schema: z.object({}),
    handler: clearMap,
  },
  delete_waypoint: {
    name: "delete_waypoint",
    description: "Delete a saved waypoint by name.",
    schema: deleteWaypointSchema,
    handler: deleteWaypoint,
  },
};
