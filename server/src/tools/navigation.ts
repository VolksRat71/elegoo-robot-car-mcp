import { z } from "zod";
import { getRobotClient } from "../robot-client.js";
import { getMapStore } from "../map-store.js";

export const scanSurroundingsSchema = z.object({
  start_angle: z.number().min(0).max(180).default(0).describe("Start angle for scan in degrees"),
  end_angle: z.number().min(0).max(180).default(180).describe("End angle for scan in degrees"),
  step: z.number().min(5).max(30).default(10).describe("Angle step between readings in degrees"),
});

export const saveWaypointSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .describe("Name for this waypoint (e.g., 'kitchen_door', 'charging_station')"),
});

export const navigateToSchema = z.object({
  waypoint: z.string().describe("Name of saved waypoint to navigate to"),
});

export async function scanSurroundings(
  params: z.infer<typeof scanSurroundingsSchema>
): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    const response = await robot.scanSurroundings(
      params.start_angle,
      params.end_angle,
      params.step
    );

    if (!response.success) {
      return `Failed to scan: ${response.error || "Unknown error"}`;
    }

    const data = response.data as { readings: Array<{ angle: number; distance: number }> };

    if (!data?.readings || data.readings.length === 0) {
      return "Scan completed but no readings received.";
    }

    // Store readings in map
    mapStore.addScanReadings(data.readings);

    // Build summary
    const pos = mapStore.getPosition();
    const minReading = data.readings.reduce((min, r) => (r.distance < min.distance ? r : min));
    const maxReading = data.readings.reduce((max, r) => (r.distance > max.distance ? r : max));

    const obstacleCount = data.readings.filter((r) => r.distance < 50).length;

    let summary = `Scan complete: ${data.readings.length} readings from ${params.start_angle}° to ${params.end_angle}°\n`;
    summary += `Robot position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) heading ${pos.heading.toFixed(1)}°\n`;
    summary += `Closest obstacle: ${minReading.distance.toFixed(1)}cm at ${minReading.angle}°\n`;
    summary += `Farthest reading: ${maxReading.distance.toFixed(1)}cm at ${maxReading.angle}°\n`;
    summary += `Obstacles within 50cm: ${obstacleCount}\n\n`;
    summary += "Readings:\n";

    // Format readings as ASCII visualization
    for (const r of data.readings) {
      const bar = "█".repeat(Math.min(20, Math.floor(r.distance / 20)));
      const empty = "░".repeat(20 - Math.min(20, Math.floor(r.distance / 20)));
      summary += `${r.angle.toString().padStart(3)}°: ${bar}${empty} ${r.distance.toFixed(0)}cm\n`;
    }

    return summary;
  } catch (error) {
    return `Error scanning: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function saveWaypoint(params: z.infer<typeof saveWaypointSchema>): Promise<string> {
  const mapStore = getMapStore();

  try {
    const waypoint = mapStore.saveWaypoint(params.name);
    return `Waypoint "${params.name}" saved at position (${waypoint.x.toFixed(1)}, ${waypoint.y.toFixed(1)}) heading ${waypoint.heading.toFixed(1)}°`;
  } catch (error) {
    return `Error saving waypoint: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function navigateTo(params: z.infer<typeof navigateToSchema>): Promise<string> {
  const robot = getRobotClient();
  const mapStore = getMapStore();

  try {
    const waypoint = mapStore.getWaypoint(params.waypoint);

    if (!waypoint) {
      const available = mapStore.listWaypoints();
      if (available.length === 0) {
        return `Waypoint "${params.waypoint}" not found. No waypoints have been saved yet.`;
      }
      return `Waypoint "${params.waypoint}" not found. Available waypoints: ${available.map((w) => w.name).join(", ")}`;
    }

    const currentPos = mapStore.getPosition();

    // Calculate distance and heading to waypoint
    const dx = waypoint.x - currentPos.x;
    const dy = waypoint.y - currentPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const targetHeading = (Math.atan2(dy, dx) * 180) / Math.PI;
    let turnAngle = targetHeading - currentPos.heading;

    // Normalize turn angle to -180 to 180
    while (turnAngle > 180) turnAngle -= 360;
    while (turnAngle < -180) turnAngle += 360;

    // Check if path is clear
    const pathClear = mapStore.isPathClear(currentPos.x, currentPos.y, waypoint.x, waypoint.y);

    if (!pathClear) {
      return `Cannot navigate to "${params.waypoint}": obstacles detected along the path. Consider scanning surroundings and finding an alternative route.`;
    }

    // Execute navigation
    let result = `Navigating to "${params.waypoint}" (${distance.toFixed(0)}cm away):\n`;

    // Turn to face waypoint
    if (Math.abs(turnAngle) > 5) {
      result += `1. Turning ${turnAngle.toFixed(0)}° to face waypoint...\n`;
      await robot.turn(turnAngle, 50);
      mapStore.updatePosition(currentPos.x, currentPos.y, targetHeading);
    }

    // Move forward
    const moveTime = (distance / 30) * 1000; // Estimate ~30cm/s at full speed
    result += `2. Moving forward ${distance.toFixed(0)}cm...\n`;
    await robot.drive("forward", 70, Math.min(moveTime, 5000));

    // Update position estimate
    mapStore.updatePosition(waypoint.x, waypoint.y, targetHeading);

    result += `3. Arrived at "${params.waypoint}" (estimated).\n`;
    result += `Note: Position is estimated via dead reckoning. For accuracy, use scan_surroundings to verify location.`;

    return result;
  } catch (error) {
    return `Error navigating: ${error instanceof Error ? error.message : "Unknown error"}`;
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
  scan_surroundings: {
    name: "scan_surroundings",
    description:
      "Pan the ultrasonic sensor across a range of angles and collect distance readings. Builds a local map of obstacles around the robot. Use this for exploration and obstacle mapping.",
    schema: scanSurroundingsSchema,
    handler: scanSurroundings,
  },
  save_waypoint: {
    name: "save_waypoint",
    description:
      "Mark the current position as a named waypoint for later navigation. Waypoints persist across sessions.",
    schema: saveWaypointSchema,
    handler: saveWaypoint,
  },
  navigate_to: {
    name: "navigate_to",
    description:
      "Navigate to a previously saved waypoint using dead reckoning. Checks for obstacles along the path before moving.",
    schema: navigateToSchema,
    handler: navigateTo,
  },
  list_waypoints: {
    name: "list_waypoints",
    description: "List all saved waypoints with their positions.",
    schema: z.object({}),
    handler: listWaypoints,
  },
};
