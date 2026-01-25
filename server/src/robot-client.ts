import WebSocket from "ws";
import { EventEmitter } from "events";

export interface RobotCommand {
  cmd: string;
  [key: string]: unknown;
}

export interface RobotResponse {
  success: boolean;
  cmd: string;
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

export class RobotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private robotUrl: string;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (value: RobotResponse) => void; reject: (error: Error) => void }
  > = new Map();
  private requestId = 0;
  private status: RobotStatus = { connected: false };

  constructor(robotUrl: string = "ws://192.168.4.1:8080") {
    super();
    this.robotUrl = robotUrl;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.robotUrl);

        this.ws.on("open", () => {
          this.status.connected = true;
          this.emit("connected");
          if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
          }
          resolve();
        });

        this.ws.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (err) {
            console.error("Failed to parse message:", err);
          }
        });

        this.ws.on("close", () => {
          this.status.connected = false;
          this.emit("disconnected");
          this.startReconnect();
        });

        this.ws.on("error", (err) => {
          console.error("WebSocket error:", err);
          if (!this.status.connected) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private startReconnect(): void {
    if (this.reconnectInterval) return;

    this.reconnectInterval = setInterval(async () => {
      console.log("Attempting to reconnect to robot...");
      try {
        await this.connect();
      } catch {
        // Will retry on next interval
      }
    }, 5000);
  }

  private handleMessage(message: RobotResponse & { requestId?: string }): void {
    if (message.requestId && this.pendingRequests.has(message.requestId)) {
      const { resolve } = this.pendingRequests.get(message.requestId)!;
      this.pendingRequests.delete(message.requestId);
      resolve(message);
    }

    // Emit for any listeners
    this.emit("message", message);

    // Handle status updates
    if (message.cmd === "status" && message.data) {
      const statusData = message.data as Partial<RobotStatus>;
      this.status = { ...this.status, ...statusData };
      this.emit("status", this.status);
    }
  }

  async send(command: RobotCommand, timeout = 5000): Promise<RobotResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to robot");
    }

    const requestId = `req_${++this.requestId}`;
    const message = { ...command, requestId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Command timeout: ${command.cmd}`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.ws!.send(JSON.stringify(message));
    });
  }

  async drive(
    direction: "forward" | "backward" | "left" | "right" | "stop",
    speed: number = 50,
    duration?: number
  ): Promise<RobotResponse> {
    return this.send({
      cmd: "drive",
      dir: direction,
      speed: Math.max(0, Math.min(100, speed)),
      duration,
    });
  }

  async turn(degrees: number, speed: number = 50): Promise<RobotResponse> {
    return this.send({
      cmd: "turn",
      degrees: Math.max(-180, Math.min(180, degrees)),
      speed: Math.max(0, Math.min(100, speed)),
    });
  }

  async emergencyStop(): Promise<RobotResponse> {
    return this.send({ cmd: "emergency_stop" });
  }

  async captureImage(): Promise<RobotResponse> {
    return this.send({ cmd: "camera", action: "capture" }, 10000);
  }

  async look(angle: number): Promise<RobotResponse> {
    return this.send({
      cmd: "servo",
      angle: Math.max(0, Math.min(180, angle)),
    });
  }

  async getDistance(): Promise<RobotResponse> {
    return this.send({ cmd: "sensor", type: "distance" });
  }

  async getLineSensors(): Promise<RobotResponse> {
    return this.send({ cmd: "sensor", type: "line" });
  }

  async scanSurroundings(
    startAngle = 0,
    endAngle = 180,
    step = 10
  ): Promise<RobotResponse> {
    return this.send(
      {
        cmd: "scan",
        startAngle,
        endAngle,
        step,
      },
      30000
    );
  }

  async getStatus(): Promise<RobotResponse> {
    return this.send({ cmd: "status" });
  }

  async setMode(
    mode: "manual" | "explore" | "line_follow" | "obstacle_avoid"
  ): Promise<RobotResponse> {
    return this.send({ cmd: "set_mode", mode });
  }

  getConnectionStatus(): RobotStatus {
    return { ...this.status };
  }

  disconnect(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status.connected = false;
  }
}

// Singleton instance
let robotClientInstance: RobotClient | null = null;

export function getRobotClient(url?: string): RobotClient {
  if (!robotClientInstance) {
    robotClientInstance = new RobotClient(
      url || process.env.ROBOT_URL || "ws://192.168.4.1:8080"
    );
  }
  return robotClientInstance;
}
