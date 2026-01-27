import { z } from "zod";
import { getRobotClient } from "../robot-client.js";

export async function getDistance(): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.getDistance();

    if (!response.success) {
      return `Failed to read distance sensor: ${response.error || "Unknown error"}`;
    }

    const data = response.data as { distance: number; note?: string };

    if (data.distance === undefined || data.distance === null) {
      return "Distance sensor returned no data.";
    }

    let description: string;
    if (data.distance < 10) {
      description = "VERY CLOSE - obstacle immediately ahead!";
    } else if (data.distance < 30) {
      description = "Close obstacle detected";
    } else if (data.distance < 100) {
      description = "Object at medium range";
    } else if (data.distance < 300) {
      description = "Object at far range";
    } else {
      description = "Clear path ahead";
    }

    const note = data.note ? ` (${data.note})` : "";
    return `Distance: ${data.distance} cm - ${description}${note}`;
  } catch (error) {
    return `Error reading distance: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export const sensorTools = {
  get_distance: {
    name: "get_distance",
    description:
      "Read the ultrasonic distance sensor. Returns distance to nearest obstacle in centimeters. Useful for obstacle detection and navigation.",
    schema: z.object({}),
    handler: getDistance,
  },
};
