import { z } from "zod";
import { getRobotClient } from "../robot-client.js";

export async function getDistance(): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.getDistance();

    if (!response.success) {
      return `Failed to read distance sensor: ${response.error || "Unknown error"}`;
    }

    const data = response.data as { distance: number };

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

    return `Distance: ${data.distance.toFixed(1)} cm - ${description}`;
  } catch (error) {
    return `Error reading distance: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export async function getLineSensors(): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.getLineSensors();

    if (!response.success) {
      return `Failed to read line sensors: ${response.error || "Unknown error"}`;
    }

    const data = response.data as { left: boolean; center: boolean; right: boolean };

    if (!data) {
      return "Line sensors returned no data.";
    }

    const sensors = [
      data.left ? "LEFT: line" : "LEFT: floor",
      data.center ? "CENTER: line" : "CENTER: floor",
      data.right ? "RIGHT: line" : "RIGHT: floor",
    ];

    // Interpretation
    let interpretation: string;
    if (data.left && data.center && data.right) {
      interpretation = "On thick line or intersection";
    } else if (data.center && !data.left && !data.right) {
      interpretation = "Centered on line";
    } else if (data.left && data.center) {
      interpretation = "Line curves right, turn right to follow";
    } else if (data.right && data.center) {
      interpretation = "Line curves left, turn left to follow";
    } else if (data.left && !data.center && !data.right) {
      interpretation = "Line is to the left";
    } else if (data.right && !data.center && !data.left) {
      interpretation = "Line is to the right";
    } else if (!data.left && !data.center && !data.right) {
      interpretation = "No line detected - lost track or on uniform surface";
    } else {
      interpretation = "Ambiguous pattern";
    }

    return `Line sensors: [${sensors.join(" | ")}]\nInterpretation: ${interpretation}`;
  } catch (error) {
    return `Error reading line sensors: ${error instanceof Error ? error.message : "Unknown error"}`;
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
  get_line_sensors: {
    name: "get_line_sensors",
    description:
      "Read the line tracking sensors. Returns state of 3 IR sensors (left, center, right) indicating whether each detects a line. Useful for line-following behavior.",
    schema: z.object({}),
    handler: getLineSensors,
  },
};
