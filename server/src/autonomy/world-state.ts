/**
 * WorldState Schema v1.0
 *
 * Defines the structured state that the LLM receives via observe().
 * This is the contract between the tactical host layer and the strategic LLM layer.
 */

import { getStockRobotClient } from "../robot-client-stock.js";
import { getMapStore } from "../map-store.js";
import { getAutonomyStateMachine } from "./state-machine.js";
import { getVisionClient, type VisionAnalysisResult } from "../vision-client.js";
import { captureImage } from "../tools/vision.js";

export type AutonomyState =
  | "IDLE"
  | "EXECUTING"
  | "AVOIDING"
  | "RECOVERING"
  | "RELOCALIZING"
  | "STUCK";

export interface WorldState {
  // Schema version for compatibility
  schema_version: "1.0";
  timestamp_ms: number;

  // Robot state machine
  autonomy_state: AutonomyState;
  last_action: string;
  stuck_counter: number;

  // Geometry (tactical)
  geometry: {
    front_min_mm: number;
    scan_bins_mm: number[]; // e.g., 7 bins at 30 degree intervals
    best_gap: {
      bearing_deg: number;
      width_mm: number;
    } | null;
  };

  // Semantics (from vision, when available)
  semantics: {
    detected_objects: {
      label: string;
      bearing_deg: number;
      confidence: number;
    }[];
    current_place_tags: string[]; // "hallway", "open_area", "cluttered"
  };

  // Map summary (strategic)
  map_summary: {
    current_place: string | null;
    nearby_places: string[];
    unexplored_frontiers: number;
    loop_closure: {
      candidates: { place_id: string; score: number }[];
      confidence: number;
    };
  };

  // Confidence levels
  confidence: {
    localization: number; // 0-1
    safety: number; // 0-1
    loop_closure: number; // 0-1
  };

  // Health & timing (for degraded-mode decisions)
  health: {
    link_rtt_ms: number;
    command_age_ms: number;
    dropped_frames: number;
    last_heartbeat_ms: number;
    battery_voltage: number;
    queue_depth: number; // pending commands
  };
}

/**
 * Options for building WorldState
 */
export interface BuildWorldStateOptions {
  /**
   * If true, capture image and run vision analysis (depth + detection).
   * This adds latency but provides semantic information.
   */
  includeVision?: boolean;
}

/**
 * Build the current WorldState by collecting data from all sources
 * @param options Configuration options for building WorldState
 */
export async function buildWorldState(options: BuildWorldStateOptions = {}): Promise<WorldState> {
  const robot = getStockRobotClient();
  const mapStore = getMapStore();
  const stateMachine = getAutonomyStateMachine();
  const visionClient = getVisionClient();

  // Get distance reading
  let frontMinMm = 9999;
  try {
    const distResult = await robot.getDistance();
    if (distResult.success && distResult.data) {
      const distance = (distResult.data as { distance: number }).distance;
      frontMinMm = distance * 10; // Convert cm to mm
    }
  } catch {
    // Use last known distance or default
    frontMinMm = robot.getLastDistance() * 10;
  }

  // Get connection status (reserved for future use)
  const _connectionStatus = robot.getConnectionStatus();
  const statusResult = await robot.getStatus();
  const statusData = statusResult.data as
    | {
        queueLength?: number;
        connected?: boolean;
      }
    | undefined;

  // Get position from map store (reserved for future use)
  const _position = mapStore.getPosition();

  // Vision analysis (optional)
  let detectedObjects: { label: string; bearing_deg: number; confidence: number }[] = [];
  let currentPlaceTags: string[] = [];

  if (options.includeVision) {
    const visionAvailable = await visionClient.isAvailable();
    if (visionAvailable) {
      try {
        // Capture image from robot camera
        const imageResult = await captureImage();
        const imageContent = imageResult.content.find((c) => c.type === "image");

        if (imageContent && imageContent.type === "image") {
          // Analyze with vision service
          const visionResult = await visionClient.analyze(imageContent.data, {
            runDepth: true,
            runDetection: true,
          });

          if (visionResult.success && visionResult.detection) {
            // Map detected objects to WorldState format
            detectedObjects = visionResult.detection.detected_objects.map((obj) => ({
              label: obj.label,
              bearing_deg: obj.bearing_deg,
              confidence: obj.confidence,
            }));
          }

          // Derive place tags from depth and detection results
          if (visionResult.success) {
            currentPlaceTags = derivePlaceTags(visionResult);
          }
        }
      } catch (error) {
        console.error("Vision analysis failed:", error);
      }
    }
  }

  // Build WorldState
  const worldState: WorldState = {
    schema_version: "1.0",
    timestamp_ms: Date.now(),

    // State machine
    autonomy_state: stateMachine.getState(),
    last_action: stateMachine.getLastAction(),
    stuck_counter: stateMachine.getStuckCounter(),

    // Geometry - pre-laser version with single ultrasonic
    geometry: {
      front_min_mm: frontMinMm,
      scan_bins_mm: [], // Empty until we have ToF scanning
      best_gap: null, // Cannot determine without scan bins
    },

    // Semantics - populated from vision when available
    semantics: {
      detected_objects: detectedObjects,
      current_place_tags: currentPlaceTags,
    },

    // Map summary - minimal pre-laser version
    map_summary: {
      current_place: null,
      nearby_places: [],
      unexplored_frontiers: 0,
      loop_closure: {
        candidates: [],
        confidence: 0,
      },
    },

    // Confidence - conservative pre-laser values
    confidence: {
      localization: 0.3, // Dead reckoning only, low confidence
      safety: frontMinMm > 200 ? 0.8 : frontMinMm > 100 ? 0.5 : 0.2,
      loop_closure: 0, // Not implemented pre-laser
    },

    // Health
    health: {
      link_rtt_ms: 0, // Not measured yet
      command_age_ms: 0, // Not tracked yet
      dropped_frames: 0, // Not tracked yet
      last_heartbeat_ms: Date.now(),
      battery_voltage: 0, // Not read from robot yet
      queue_depth: statusData?.queueLength ?? 0,
    },
  };

  return worldState;
}

/**
 * Derive place tags from vision analysis results
 */
function derivePlaceTags(visionResult: VisionAnalysisResult): string[] {
  const tags: string[] = [];

  // Analyze depth zones
  if (visionResult.depth) {
    const { left, center, right } = visionResult.depth.depth_zones;
    const avgDepth = (left + center + right) / 3;

    if (avgDepth < 0.3) {
      tags.push("open_area");
    } else if (avgDepth > 0.7) {
      tags.push("cluttered");
    }

    // Check for corridor-like depth pattern (walls on sides, clear ahead)
    if (left > 0.6 && right > 0.6 && center < 0.4) {
      tags.push("hallway");
    }
  }

  // Analyze detected objects
  if (visionResult.detection) {
    const labels = visionResult.detection.detected_objects.map((o) => o.label);

    // Infer room type from detected objects
    if (labels.includes("chair") || labels.includes("couch") || labels.includes("tv")) {
      tags.push("living_space");
    }
    if (labels.includes("bed")) {
      tags.push("bedroom");
    }
    if (labels.includes("dining table") || labels.includes("refrigerator")) {
      tags.push("kitchen_area");
    }
    if (labels.includes("person") || labels.includes("dog") || labels.includes("cat")) {
      tags.push("occupied");
    }
  }

  return tags;
}

/**
 * Format WorldState as a human-readable string for LLM consumption
 */
export function formatWorldState(state: WorldState): string {
  const lines: string[] = [];

  lines.push(`=== WorldState v${state.schema_version} ===`);
  lines.push(`Timestamp: ${new Date(state.timestamp_ms).toISOString()}`);
  lines.push("");

  lines.push(`[Autonomy]`);
  lines.push(`  State: ${state.autonomy_state}`);
  lines.push(`  Last Action: ${state.last_action || "(none)"}`);
  lines.push(`  Stuck Counter: ${state.stuck_counter}`);
  lines.push("");

  lines.push(`[Geometry]`);
  lines.push(`  Front Distance: ${state.geometry.front_min_mm}mm`);
  if (state.geometry.scan_bins_mm.length > 0) {
    lines.push(`  Scan Bins: [${state.geometry.scan_bins_mm.join(", ")}]`);
  }
  if (state.geometry.best_gap) {
    lines.push(
      `  Best Gap: ${state.geometry.best_gap.bearing_deg}deg, ${state.geometry.best_gap.width_mm}mm wide`
    );
  }
  lines.push("");

  lines.push(`[Confidence]`);
  lines.push(`  Localization: ${(state.confidence.localization * 100).toFixed(0)}%`);
  lines.push(`  Safety: ${(state.confidence.safety * 100).toFixed(0)}%`);
  lines.push("");

  lines.push(`[Health]`);
  lines.push(`  Queue Depth: ${state.health.queue_depth}`);
  lines.push(`  Connected: ${state.health.queue_depth >= 0 ? "Yes" : "Unknown"}`);

  return lines.join("\n");
}
