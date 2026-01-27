/**
 * Robot Proxy Client
 *
 * Forwards all robot commands to the Python vision service.
 * This centralizes all robot communication in one place (Python)
 * and ensures consistent connection management.
 *
 * The Python service handles:
 * - TCP connection to robot
 * - Reconnect-every-3 pattern for ESP32 stability
 * - Camera stream management
 */

import { EventEmitter } from "events";

export interface RobotResponse {
  success: boolean;
  cmd?: string;
  data?: unknown;
  error?: string;
}

export interface RobotStatus {
  connected: boolean;
  battery?: number;
  wifiSignal?: number;
  mode?: string;
  position?: { x: number; y: number; heading: number };
}

interface ProxyMetrics {
  commands_sent: number;
  commands_success: number;
  commands_failed: number;
  success_rate: number;
  avg_latency_ms: number;
  connection_drops: number;
  reconnections: number;
}

export class RobotProxy extends EventEmitter {
  private serviceUrl: string;
  private _connected: boolean = false;
  private lastPosition = { x: 0, y: 0, heading: 0 };

  constructor(serviceUrl: string = "http://localhost:8765") {
    super();
    this.serviceUrl = serviceUrl;
  }

  /**
   * Check if Python service is available
   */
  async connect(): Promise<void> {
    try {
      const response = await fetch(`${this.serviceUrl}/health`);
      if (response.ok) {
        this._connected = true;
        this.emit("connected");
        console.error("[RobotProxy] Connected to Python service");
      } else {
        throw new Error(`Service returned ${response.status}`);
      }
    } catch (error) {
      this._connected = false;
      throw new Error(
        `Cannot connect to Python service at ${this.serviceUrl}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit("disconnected");
  }

  isConnected(): boolean {
    return this._connected;
  }

  getConnectionStatus(): { connected: boolean; host: string; port: string } {
    return {
      connected: this._connected,
      host: this.serviceUrl,
      port: "proxy",
    };
  }

  /**
   * Internal method to call Python service endpoints
   */
  private async callService<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<T> {
    const url = `${this.serviceUrl}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (body && method === "POST") {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      // If service is unreachable, mark as disconnected
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this._connected = false;
        this.emit("disconnected");
      }
      throw error;
    }
  }

  // === Movement Commands ===

  async drive(
    direction: "forward" | "backward" | "left" | "right" | "stop",
    speed: number = 50,
    duration?: number
  ): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      direction: string;
      speed: number;
      duration_ms: number;
    }>("/robot/drive", "POST", {
      direction,
      speed,
      duration_ms: duration || 0,
    });

    // Update estimated position
    if (result.success && direction === "forward" && duration) {
      const dist = (duration / 1000) * speed * 0.05; // rough estimate
      this.lastPosition.x +=
        dist * Math.cos((this.lastPosition.heading * Math.PI) / 180);
      this.lastPosition.y +=
        dist * Math.sin((this.lastPosition.heading * Math.PI) / 180);
    }

    return {
      success: result.success,
      cmd: "drive",
      data: result,
    };
  }

  async turn(degrees: number, speed: number = 50): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      degrees: number;
      speed: number;
    }>("/robot/turn", "POST", { degrees, speed });

    // Update estimated heading
    if (result.success) {
      this.lastPosition.heading =
        (this.lastPosition.heading + degrees + 360) % 360;
    }

    return {
      success: result.success,
      cmd: "turn",
      data: result,
    };
  }

  async emergencyStop(): Promise<RobotResponse> {
    const result = await this.callService<{ success: boolean }>(
      "/robot/stop",
      "POST"
    );
    return {
      success: result.success,
      cmd: "stop",
    };
  }

  // === Camera Commands ===

  async look(angle: number): Promise<RobotResponse> {
    const result = await this.callService<{ success: boolean; angle: number }>(
      "/robot/look",
      "POST",
      { angle }
    );
    return {
      success: result.success,
      cmd: "look",
      data: result,
    };
  }

  async captureImage(): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      image_base64: string;
      frame_age_ms: number;
      width: number;
      height: number;
    }>("/camera/capture");

    return {
      success: result.success,
      cmd: "capture",
      data: {
        image: result.image_base64,
        frameAge: result.frame_age_ms,
        width: result.width,
        height: result.height,
      },
    };
  }

  // === Sensor Commands ===

  async getDistance(): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      distance_cm: number | null;
      raw_response: string | null;
    }>("/robot/distance");
    return {
      success: result.success,
      cmd: "distance",
      data: { distance: result.distance_cm },
    };
  }

  async ping(): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      latency_ms: number;
    }>("/robot/ping");
    return {
      success: result.success,
      cmd: "ping",
      data: result,
    };
  }

  // === LED Commands ===

  async setLed(
    r: number,
    g: number,
    b: number,
    led: number = 0
  ): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      r: number;
      g: number;
      b: number;
    }>("/robot/led", "POST", { r, g, b, led });
    return {
      success: result.success,
      cmd: "led",
      data: result,
    };
  }

  // === Status Commands ===

  async getStatus(): Promise<RobotResponse> {
    const result = await this.callService<{
      robot: { connected: boolean; metrics: ProxyMetrics };
      camera: { running: boolean; frame_count: number };
      vision: { depth_loaded: boolean; detection_loaded: boolean };
    }>("/status");

    return {
      success: true,
      cmd: "status",
      data: {
        connected: result.robot.connected,
        mode: "proxy",
        metrics: result.robot.metrics,
        camera: result.camera,
        vision: result.vision,
      },
    };
  }

  async getMetrics(): Promise<ProxyMetrics> {
    const result = await this.callService<ProxyMetrics>("/robot/metrics");
    return result;
  }

  getPosition(): { x: number; y: number; heading: number } {
    return { ...this.lastPosition };
  }

  resetPosition(): void {
    this.lastPosition = { x: 0, y: 0, heading: 0 };
  }

  // === Raw Command (for advanced use) ===

  async sendRaw(
    n: number,
    d1: number = 0,
    d2: number = 0,
    d3: number = 0,
    d4: number = 0
  ): Promise<RobotResponse> {
    const result = await this.callService<{
      success: boolean;
      latency_ms: number;
      response: string | null;
    }>("/robot/raw", "POST", { n, d1, d2, d3, d4 });
    return {
      success: result.success,
      cmd: "raw",
      data: result,
    };
  }

  // === Scan (sweep ultrasonic) ===

  async scanSweep(
    angles: number[] = [0, 45, 90, 135, 180]
  ): Promise<{ angle: number; distance: number }[]> {
    const readings: { angle: number; distance: number }[] = [];

    for (const angle of angles) {
      await this.look(angle);
      await new Promise((r) => setTimeout(r, 200)); // Wait for servo
      const distResult = await this.getDistance();
      const dist =
        (distResult.data as { distance: number | null })?.distance ?? 999;
      readings.push({ angle, distance: dist });
    }

    // Return to center
    await this.look(90);

    return readings;
  }
}

// Singleton instance
let proxyInstance: RobotProxy | null = null;

export function getRobotProxy(
  serviceUrl: string = "http://localhost:8765"
): RobotProxy {
  if (!proxyInstance) {
    proxyInstance = new RobotProxy(serviceUrl);
  }
  return proxyInstance;
}
