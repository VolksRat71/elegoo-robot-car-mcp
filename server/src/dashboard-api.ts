/**
 * Dashboard API Handler
 *
 * Provides REST endpoints for the web dashboard, using the SAME underlying
 * functions as the MCP tools - no separate service layer.
 */

import { IncomingMessage, ServerResponse } from "http";
import { getStockRobotClient } from "./robot-client-stock.js";
import { buildWorldState } from "./autonomy/world-state.js";
import { getVisionClient } from "./vision-client.js";
import { captureImage } from "./tools/vision.js";
import { explore as tacticalExplore, stop as tacticalStop } from "./tools/tactical.js";

interface CommandRequest {
  command: "drive" | "turn" | "stop" | "explore";
  params?: Record<string, unknown>;
}

interface Snapshot {
  timestamp: number;
  camera_image?: string;
  depth_image?: string;
  annotated_image?: string;
  depth?: {
    center_depth: number;
    depth_zones: { left: number; center: number; right: number };
    image_size: { width: number; height: number };
  };
  detection?: {
    detected_objects: Array<{
      label: string;
      bearing_deg: number;
      confidence: number;
      bbox?: { x1: number; y1: number; x2: number; y2: number };
    }>;
    count: number;
  };
  world_state: Awaited<ReturnType<typeof buildWorldState>>;
  robot_connected: boolean;
  vision_available: boolean;
}

/**
 * Handle GET /api/snapshot
 * Returns current robot state, camera image, and vision analysis
 */
async function handleSnapshot(): Promise<Snapshot> {
  const robot = getStockRobotClient();
  const visionClient = getVisionClient();

  // Check service availability
  const robotConnected = robot.isConnected();
  const visionAvailable = await visionClient.isAvailable();

  // Build world state (same function used by MCP observe tool)
  const worldState = await buildWorldState();

  // Capture camera image (same function used by MCP capture_image tool)
  let cameraImage: string | undefined;
  const imageResult = await captureImage();
  const imageContent = imageResult.content.find((c) => c.type === "image");
  if (imageContent && imageContent.type === "image") {
    cameraImage = imageContent.data;
  }

  // Run vision analysis if we have an image and vision is available
  let depthImage: string | undefined;
  let annotatedImage: string | undefined;
  let depth: Snapshot["depth"];
  let detection: Snapshot["detection"];

  if (cameraImage && visionAvailable) {
    const visionResult = await visionClient.analyze(cameraImage, {
      runDepth: true,
      runDetection: true,
      includeImages: true, // Get visualization images for dashboard
    });

    if (visionResult.success) {
      depth = visionResult.depth;
      detection = visionResult.detection;
      depthImage = visionResult.depth_image;
      annotatedImage = visionResult.annotated_image;
    }
  }

  return {
    timestamp: Date.now(),
    camera_image: cameraImage,
    depth_image: depthImage,
    annotated_image: annotatedImage,
    depth,
    detection,
    world_state: worldState,
    robot_connected: robotConnected,
    vision_available: visionAvailable,
  };
}

/**
 * Handle POST /api/command
 * Executes robot commands using the same functions as MCP tools
 */
async function handleCommand(
  body: CommandRequest
): Promise<{ success: boolean; message?: string; error?: string }> {
  const robot = getStockRobotClient();
  const { command, params = {} } = body;

  try {
    switch (command) {
      case "drive": {
        const direction = (params.direction as string) || "forward";
        const speed = (params.speed as number) || 50;
        const duration = (params.duration_ms as number) || 500;

        // Use the same robot client methods as MCP tools
        const result = await robot.drive(
          direction as "forward" | "backward" | "left" | "right" | "stop",
          speed,
          duration
        );
        return {
          success: result.success,
          message: result.success ? `Drove ${direction} for ${duration}ms` : undefined,
          error: result.error,
        };
      }

      case "turn": {
        const degrees = (params.degrees as number) || 0;
        const speed = (params.speed as number) || 40;

        const result = await robot.turn(degrees, speed);
        return {
          success: result.success,
          message: result.success ? `Turned ${degrees} degrees` : undefined,
          error: result.error,
        };
      }

      case "stop": {
        // Use the same stop function as MCP tool
        const message = await tacticalStop();
        return { success: true, message };
      }

      case "explore": {
        const duration = (params.duration_s as number) || 15;

        // Use the same explore function as MCP tool
        const message = await tacticalExplore({ duration_s: duration });
        return { success: true, message };
      }

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Parse JSON body from request
 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Handle dashboard API requests
 * Returns true if the request was handled, false otherwise
 */
export async function handleDashboardApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Set CORS headers for dashboard
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /api/snapshot
  if (pathname === "/api/snapshot" && req.method === "GET") {
    try {
      const snapshot = await handleSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Internal error",
        })
      );
    }
    return true;
  }

  // POST /api/command
  if (pathname === "/api/command" && req.method === "POST") {
    try {
      const body = (await parseBody(req)) as CommandRequest;
      const result = await handleCommand(body);
      res.writeHead(result.success ? 200 : 400, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : "Invalid request",
        })
      );
    }
    return true;
  }

  return false;
}
