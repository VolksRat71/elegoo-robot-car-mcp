/**
 * Vision Service Client
 *
 * HTTP client for the Python vision sidecar service.
 * Provides depth estimation and object detection for images.
 */

export interface DetectedObject {
  label: string;
  bearing_deg: number;
  confidence: number;
  bbox?: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}

export interface DepthResult {
  center_depth: number;
  depth_zones: {
    left: number;
    center: number;
    right: number;
  };
  image_size: {
    width: number;
    height: number;
  };
}

export interface VisionAnalysisResult {
  success: boolean;
  depth?: DepthResult;
  detection?: {
    detected_objects: DetectedObject[];
    count: number;
  };
  depth_image?: string; // base64 colormap
  annotated_image?: string; // base64 with bounding boxes
  error?: string;
}

export interface MontageResult {
  success: boolean;
  image_base64?: string;
  snapshot_count?: number;
  snapshots?: string[];
  width?: number;
  height?: number;
  error?: string;
}

export interface NudgeSettings {
  active: boolean;
  goal: string | null;
  prefer_direction: "left" | "right" | null;
  bias_strength: number;
  look_for: string[];
  avoid: string[];
  notes: string;
}

const DEFAULT_VISION_URL = "http://localhost:8765";

export class VisionClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl?: string, timeout: number = 10000) {
    this.baseUrl = baseUrl || process.env.VISION_SERVICE_URL || DEFAULT_VISION_URL;
    this.timeout = timeout;
  }

  /**
   * Check if the vision service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as { models_loaded?: boolean };
        return data.models_loaded === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Analyze an image for depth and/or object detection
   */
  async analyze(
    imageBase64: string,
    options: {
      runDepth?: boolean;
      runDetection?: boolean;
      detectionConfidence?: number;
      includeImages?: boolean;
    } = {}
  ): Promise<VisionAnalysisResult> {
    const {
      runDepth = true,
      runDetection = true,
      detectionConfidence = 0.25,
      includeImages = false,
    } = options;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_base64: imageBase64,
          run_depth: runDepth,
          run_detection: runDetection,
          detection_confidence: detectionConfidence,
          include_images: includeImages,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `Vision service returned ${response.status}: ${response.statusText}`,
        };
      }

      return (await response.json()) as VisionAnalysisResult;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false, error: "Vision service request timed out" };
      }
      return {
        success: false,
        error: `Vision service error: ${error instanceof Error ? error.message : "Unknown"}`,
      };
    }
  }

  /**
   * Get journey montage (grid of recent drive snapshots)
   */
  async getMontage(count: number = 6): Promise<MontageResult> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/montage?count=${count}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `Montage request failed: ${response.status} ${response.statusText}`,
        };
      }

      return (await response.json()) as MontageResult;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false, error: "Montage request timed out" };
      }
      return {
        success: false,
        error: `Montage error: ${error instanceof Error ? error.message : "Unknown"}`,
      };
    }
  }

  /**
   * Get current nudge settings
   */
  async getNudges(): Promise<NudgeSettings | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.baseUrl}/nudges`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        return (await response.json()) as NudgeSettings;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Set nudge settings for Claude copilot mode
   */
  async setNudge(settings: Partial<NudgeSettings>): Promise<NudgeSettings | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.baseUrl}/nudge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        return (await response.json()) as NudgeSettings;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clear all nudges
   */
  async clearNudges(): Promise<NudgeSettings | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.baseUrl}/nudge/clear`, {
        method: "POST",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        return (await response.json()) as NudgeSettings;
      }
      return null;
    } catch {
      return null;
    }
  }
}

// Singleton instance
let visionClientInstance: VisionClient | null = null;

export function getVisionClient(): VisionClient {
  if (!visionClientInstance) {
    visionClientInstance = new VisionClient();
  }
  return visionClientInstance;
}
