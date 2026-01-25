import net from "net";
import { EventEmitter } from "events";

/**
 * Robot client for stock Elegoo firmware
 * Uses TCP socket on port 100 with JSON commands
 * Command format: {"H": 1, "N": <cmd>, "D1": <p1>, "D2": <p2>, "D3": <p3>}
 */

// Stock Elegoo command numbers (based on reverse engineering)
// These may need adjustment based on actual firmware version
const CMD = {
  // Motor commands
  FORWARD: 1,
  BACKWARD: 2,
  LEFT: 3,
  RIGHT: 4,
  STOP: 0,

  // Servo commands
  SERVO_HORIZONTAL: 5, // Camera pan servo
  SERVO_VERTICAL: 6,   // Camera tilt servo (if present)

  // Sensor commands
  ULTRASONIC: 21,
  LINE_TRACKING: 22,

  // Speed control
  SET_SPEED: 10,

  // Mode commands
  LINE_FOLLOW_MODE: 11,
  OBSTACLE_AVOID_MODE: 12,
  FOLLOW_MODE: 13,
};

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

export class StockRobotClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private robotHost: string;
  private robotPort: number;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private status: RobotStatus = { connected: false };
  private responseBuffer: string = "";
  private currentSpeed: number = 150; // Default speed (0-255)

  constructor(host: string = "192.168.4.1", port: number = 100) {
    super();
    this.robotHost = host;
    this.robotPort = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error("Connection timeout"));
      }, 5000);

      this.socket.connect(this.robotPort, this.robotHost, () => {
        clearTimeout(timeout);
        this.status.connected = true;
        this.emit("connected");
        console.error(`Connected to robot at ${this.robotHost}:${this.robotPort}`);
        resolve();
      });

      this.socket.on("data", (data) => {
        this.responseBuffer += data.toString();
        this.processBuffer();
      });

      this.socket.on("close", () => {
        this.status.connected = false;
        this.emit("disconnected");
        this.startReconnect();
      });

      this.socket.on("error", (err) => {
        clearTimeout(timeout);
        console.error("Socket error:", err.message);
        if (!this.status.connected) {
          reject(err);
        }
      });
    });
  }

  private processBuffer(): void {
    // Try to parse complete JSON objects from buffer
    // Stock firmware may send responses or status updates
    const lines = this.responseBuffer.split("\n");
    this.responseBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const data = JSON.parse(line);
          this.emit("message", data);
        } catch {
          // Not valid JSON, might be raw sensor data
          this.emit("rawData", line);
        }
      }
    }
  }

  private startReconnect(): void {
    if (this.reconnectInterval) return;

    this.reconnectInterval = setInterval(async () => {
      console.error("Attempting to reconnect to robot...");
      try {
        await this.connect();
        if (this.reconnectInterval) {
          clearInterval(this.reconnectInterval);
          this.reconnectInterval = null;
        }
      } catch {
        // Will retry on next interval
      }
    }, 5000);
  }

  private sendCommand(n: number, d1: number = 0, d2: number = 0, d3: number = 0): void {
    if (!this.socket || !this.status.connected) {
      throw new Error("Not connected to robot");
    }

    const cmd = { H: 1, N: n, D1: d1, D2: d2, D3: d3 };
    const message = JSON.stringify(cmd) + "\n";
    this.socket.write(message);
    console.error(`Sent: ${message.trim()}`);
  }

  // Movement commands
  async drive(
    direction: "forward" | "backward" | "left" | "right" | "stop",
    speed: number = 50,
    duration?: number
  ): Promise<RobotResponse> {
    // Convert 0-100 speed to 0-255
    const mappedSpeed = Math.round((speed / 100) * 255);
    this.currentSpeed = mappedSpeed;

    const dirMap: Record<string, number> = {
      forward: CMD.FORWARD,
      backward: CMD.BACKWARD,
      left: CMD.LEFT,
      right: CMD.RIGHT,
      stop: CMD.STOP,
    };

    try {
      // Set speed first
      this.sendCommand(CMD.SET_SPEED, mappedSpeed, mappedSpeed, mappedSpeed);

      // Then send direction
      this.sendCommand(dirMap[direction]);

      // If duration specified, stop after delay
      if (duration && direction !== "stop") {
        setTimeout(() => {
          this.sendCommand(CMD.STOP);
        }, duration);
      }

      return { success: true, cmd: "drive", data: { direction, speed } };
    } catch (error) {
      return {
        success: false,
        cmd: "drive",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async turn(degrees: number, speed: number = 50): Promise<RobotResponse> {
    const mappedSpeed = Math.round((speed / 100) * 255);

    // Estimate duration based on degrees (rough approximation)
    const duration = Math.abs(degrees) * 10; // ~10ms per degree at full speed

    try {
      this.sendCommand(CMD.SET_SPEED, mappedSpeed, mappedSpeed, mappedSpeed);

      if (degrees > 0) {
        this.sendCommand(CMD.RIGHT);
      } else {
        this.sendCommand(CMD.LEFT);
      }

      // Stop after estimated turn duration
      setTimeout(() => {
        this.sendCommand(CMD.STOP);
      }, duration);

      return { success: true, cmd: "turn", data: { degrees, speed } };
    } catch (error) {
      return {
        success: false,
        cmd: "turn",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async emergencyStop(): Promise<RobotResponse> {
    try {
      this.sendCommand(CMD.STOP);
      return { success: true, cmd: "emergency_stop" };
    } catch (error) {
      return {
        success: false,
        cmd: "emergency_stop",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async look(angle: number): Promise<RobotResponse> {
    // Servo angle: 0-180 degrees
    const clampedAngle = Math.max(0, Math.min(180, angle));

    try {
      // D1=1 for horizontal servo, D2=angle
      this.sendCommand(CMD.SERVO_HORIZONTAL, 1, clampedAngle);
      return { success: true, cmd: "look", data: { angle: clampedAngle } };
    } catch (error) {
      return {
        success: false,
        cmd: "look",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getDistance(): Promise<RobotResponse> {
    // Stock firmware may not support sensor queries via TCP
    // This would need the ESP32 to relay from Arduino
    try {
      this.sendCommand(CMD.ULTRASONIC);
      // Response would come async via the message event
      return {
        success: true,
        cmd: "get_distance",
        data: { distance: -1, note: "Async response - check message events" }
      };
    } catch (error) {
      return {
        success: false,
        cmd: "get_distance",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getLineSensors(): Promise<RobotResponse> {
    try {
      this.sendCommand(CMD.LINE_TRACKING);
      return {
        success: true,
        cmd: "get_line_sensors",
        data: { note: "Async response - check message events" }
      };
    } catch (error) {
      return {
        success: false,
        cmd: "get_line_sensors",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async captureImage(): Promise<RobotResponse> {
    // Stock firmware serves camera stream via HTTP, not TCP commands
    // Camera is at http://192.168.4.1:80/capture or similar
    return {
      success: false,
      cmd: "capture_image",
      error: "Use HTTP endpoint http://192.168.4.1/capture for camera",
    };
  }

  async scanSurroundings(
    startAngle = 0,
    endAngle = 180,
    step = 10
  ): Promise<RobotResponse> {
    // Not directly supported by stock firmware
    return {
      success: false,
      cmd: "scan",
      error: "Scan not supported by stock firmware - use custom firmware",
    };
  }

  async getStatus(): Promise<RobotResponse> {
    return {
      success: true,
      cmd: "status",
      data: {
        connected: this.status.connected,
        mode: "stock",
        note: "Limited status available with stock firmware",
      },
    };
  }

  async setMode(
    mode: "manual" | "explore" | "line_follow" | "obstacle_avoid"
  ): Promise<RobotResponse> {
    const modeMap: Record<string, number> = {
      line_follow: CMD.LINE_FOLLOW_MODE,
      obstacle_avoid: CMD.OBSTACLE_AVOID_MODE,
      manual: CMD.STOP, // Stop any autonomous mode
    };

    try {
      if (modeMap[mode]) {
        this.sendCommand(modeMap[mode]);
      }
      return { success: true, cmd: "set_mode", data: { mode } };
    } catch (error) {
      return {
        success: false,
        cmd: "set_mode",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  getConnectionStatus(): RobotStatus {
    return { ...this.status };
  }

  disconnect(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.status.connected = false;
  }
}

// Factory function to create either stock or custom client
let robotClientInstance: StockRobotClient | null = null;

export function getStockRobotClient(host?: string, port?: number): StockRobotClient {
  if (!robotClientInstance) {
    robotClientInstance = new StockRobotClient(
      host || process.env.ROBOT_HOST || "192.168.4.1",
      port || parseInt(process.env.ROBOT_PORT || "100")
    );
  }
  return robotClientInstance;
}
