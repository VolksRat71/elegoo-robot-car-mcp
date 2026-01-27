import { z } from "zod";
import { getRobotClient } from "../robot-client.js";

// Camera endpoint on stock Elegoo firmware
const CAMERA_HOST = process.env.CAMERA_HOST || "192.168.4.1";
const CAMERA_PORT = process.env.CAMERA_PORT || "80";
const CAMERA_URL = `http://${CAMERA_HOST}:${CAMERA_PORT}`;

export const lookSchema = z.object({
  angle: z
    .number()
    .min(0)
    .max(180)
    .describe("Servo angle in degrees. 0 = full left, 90 = center, 180 = full right."),
});

export async function captureImage(): Promise<{
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
}> {
  try {
    // Try common Elegoo camera endpoints
    const endpoints = [
      `${CAMERA_URL}/capture`,
      `${CAMERA_URL}/jpg`,
      `${CAMERA_URL}/cam-hi.jpg`,
      `${CAMERA_URL}/cam-lo.jpg`,
    ];

    let imageBuffer: Buffer | null = null;
    let usedEndpoint = "";

    for (const endpoint of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(endpoint, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("image")) {
            imageBuffer = Buffer.from(await response.arrayBuffer());
            usedEndpoint = endpoint;
            break;
          }
        }
      } catch {
        // Try next endpoint
        continue;
      }
    }

    if (!imageBuffer) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to capture image. Tried endpoints: ${endpoints.join(", ")}. Make sure you're connected to ELEGOO WiFi and camera is enabled.`,
          },
        ],
      };
    }

    const base64Image = imageBuffer.toString("base64");

    return {
      content: [
        {
          type: "text",
          text: `Image captured from ${usedEndpoint} (${imageBuffer.length} bytes).`,
        },
        {
          type: "image",
          data: base64Image,
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

    const direction = params.angle < 60 ? "left" : params.angle > 120 ? "right" : "center";
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
