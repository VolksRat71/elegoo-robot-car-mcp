import { z } from "zod";
import { getRobotClient } from "../robot-client.js";

export const lookSchema = z.object({
  angle: z
    .number()
    .min(0)
    .max(180)
    .describe("Servo angle in degrees. 0 = full left, 90 = center, 180 = full right."),
});

export async function captureImage(): Promise<{
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
}> {
  const robot = getRobotClient();

  try {
    const response = await robot.captureImage();

    if (!response.success) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to capture image: ${response.error || "Unknown error"}`,
          },
        ],
      };
    }

    const imageData = response.data as { image: string; width?: number; height?: number };

    if (!imageData?.image) {
      return {
        content: [
          {
            type: "text",
            text: "No image data received from robot camera.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Image captured successfully${imageData.width ? ` (${imageData.width}x${imageData.height})` : ""}.`,
        },
        {
          type: "image",
          data: imageData.image,
          mimeType: "image/jpeg",
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error capturing image: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
    };
  }
}

export async function look(params: z.infer<typeof lookSchema>): Promise<string> {
  const robot = getRobotClient();

  try {
    const response = await robot.look(params.angle);

    if (!response.success) {
      return `Failed to move camera: ${response.error || "Unknown error"}`;
    }

    const direction =
      params.angle < 60 ? "left" : params.angle > 120 ? "right" : "center";
    return `Camera servo moved to ${params.angle}° (facing ${direction}).`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

export const visionTools = {
  capture_image: {
    name: "capture_image",
    description:
      "Capture a photo from the robot's camera. Returns the image for visual analysis. Use this to see what the robot sees.",
    schema: z.object({}),
    handler: captureImage,
  },
  look: {
    name: "look",
    description:
      "Pan the camera servo to look in a direction. 0° = full left, 90° = center forward, 180° = full right.",
    schema: lookSchema,
    handler: look,
  },
};
