import net from "net";
import { EventEmitter } from "events";

/**
 * Robot client for stock Elegoo firmware
 * Uses TCP socket on port 100 with JSON commands
 * Command format: {"H": 1, "N": <cmd>, "D1": <p1>, "D2": <p2>, "D3": <p3>}
 */

/**
 * Elegoo Stock Firmware Command Reference (discovered via source code analysis)
 * Format: {"H":"1","N":<cmd>,"D1":<p1>,"D2":<p2>,"D3":<p3>,"D4":<p4>}\n
 */
const CMD = {
  // N=1: Motor control - D1=motor(0=all,1=right,2=left), D2=speed(0-250), D3=dir(0=stop,1=fwd,2=back)
  MOTOR_CONTROL: 1,

  // N=3: Car direction - D1=dir(0=fwd,1=back,2=left,3=right,4-7=diag,8=stop), D2=speed
  CAR_DIRECTION: 3,

  // N=4: Motor speed - D1=left_speed, D2=right_speed
  MOTOR_SPEED: 4,

  // N=5: Servo control - D1=servo(1=pan), D2=angle(0-180) **CONFIRMED WORKING**
  SERVO: 5,

  // N=8: LED control - D1=led(0=all), D2=R, D3=G, D4=B
  LED: 8,

  // N=21: Ultrasonic sensor - D1=1
  ULTRASONIC: 21,

  // N=22: Line tracking sensor - D1=1
  LINE_TRACKING: 22,

  // N=23: Ground check - returns {1_true} or {1_false}
  GROUND_CHECK: 23,

  // N=100: Enter standby mode - clear all functions
  STANDBY: 100,
};

// Direction values for N=3 (CAR_DIRECTION)
const DIR = {
  FORWARD: 0,
  BACKWARD: 1,
  LEFT: 2,
  RIGHT: 3,
  FORWARD_LEFT: 4,
  FORWARD_RIGHT: 5,
  BACKWARD_LEFT: 6,
  BACKWARD_RIGHT: 7,
  STOP: 8,
};

// Motor direction values for N=1 (MOTOR_CONTROL)
const MOTOR_DIR = {
  STOP: 0,
  FORWARD: 1,
  BACKWARD: 2,
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

  private sendCommand(n: number, d1: number = 0, d2: number = 0, d3: number = 0, d4: number = 0): void {
    if (!this.socket || !this.status.connected) {
      throw new Error("Not connected to robot");
    }

    // H must be string "1" per Elegoo protocol
    const cmd: Record<string, string | number> = { H: "1", N: n };
    if (d1 !== 0) cmd.D1 = d1;
    if (d2 !== 0) cmd.D2 = d2;
    if (d3 !== 0) cmd.D3 = d3;
    if (d4 !== 0) cmd.D4 = d4;

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
    // Convert 0-100 speed to 0-250 (Elegoo max)
    const mappedSpeed = Math.round((speed / 100) * 250);
    this.currentSpeed = mappedSpeed;

    // Map direction to D1 value for N=3 (CAR_DIRECTION)
    const dirMap: Record<string, number> = {
      forward: DIR.FORWARD,
      backward: DIR.BACKWARD,
      left: DIR.LEFT,
      right: DIR.RIGHT,
      stop: DIR.STOP,
    };

    try {
      // Enter standby first to clear any autonomous modes
      this.sendCommand(CMD.STANDBY);

      // Use N=3 (CAR_DIRECTION) with D1=direction, D2=speed
      this.sendCommand(CMD.CAR_DIRECTION, dirMap[direction], mappedSpeed);

      // If duration specified, stop after delay
      if (duration && direction !== "stop") {
        setTimeout(() => {
          this.sendCommand(CMD.CAR_DIRECTION, DIR.STOP, 0);
        }, duration);
      }

      return { success: true, cmd: "drive", data: { direction, speed, mappedSpeed } };
    } catch (error) {
      return {
        success: false,
        cmd: "drive",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async turn(degrees: number, speed: number = 50): Promise<RobotResponse> {
    const mappedSpeed = Math.round((speed / 100) * 250);

    // Estimate duration based on degrees (rough approximation)
    const duration = Math.abs(degrees) * 10; // ~10ms per degree at full speed

    try {
      // Enter standby first
      this.sendCommand(CMD.STANDBY);

      // Use N=3 with left/right direction
      const direction = degrees > 0 ? DIR.RIGHT : DIR.LEFT;
      this.sendCommand(CMD.CAR_DIRECTION, direction, mappedSpeed);

      // Stop after estimated turn duration
      setTimeout(() => {
        this.sendCommand(CMD.CAR_DIRECTION, DIR.STOP, 0);
      }, duration);

      return { success: true, cmd: "turn", data: { degrees, speed, mappedSpeed } };
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
      // Send stop command immediately
      this.sendCommand(CMD.CAR_DIRECTION, DIR.STOP, 0);
      // Also enter standby to halt any autonomous modes
      this.sendCommand(CMD.STANDBY);
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
      // N=5: Servo control - D1=servo(1=pan), D2=angle
      // **CONFIRMED WORKING** in testing
      this.sendCommand(CMD.SERVO, 1, clampedAngle);
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
    try {
      // N=21: Ultrasonic sensor - D1=1
      this.sendCommand(CMD.ULTRASONIC, 1);
      // Response comes async via the message event
      return {
        success: true,
        cmd: "get_distance",
        data: { note: "Response arrives asynchronously - listen for 'message' event" }
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
      // N=22: Line tracking sensor - D1=1
      this.sendCommand(CMD.LINE_TRACKING, 1);
      return {
        success: true,
        cmd: "get_line_sensors",
        data: { note: "Response arrives asynchronously - listen for 'message' event" }
      };
    } catch (error) {
      return {
        success: false,
        cmd: "get_line_sensors",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async setLed(r: number, g: number, b: number, led: number = 0): Promise<RobotResponse> {
    try {
      // N=8: LED control - D1=led(0=all), D2=R, D3=G, D4=B
      this.sendCommand(CMD.LED, led, r, g, b);
      return { success: true, cmd: "set_led", data: { r, g, b, led } };
    } catch (error) {
      return {
        success: false,
        cmd: "set_led",
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
    // Implement scan by panning servo and reading ultrasonic at each step
    // This is a software-level implementation using basic commands
    try {
      const readings: Array<{ angle: number; distance?: number }> = [];

      for (let angle = startAngle; angle <= endAngle; angle += step) {
        // Pan to angle
        this.sendCommand(CMD.SERVO, 1, angle);
        // Wait for servo to move
        await new Promise(resolve => setTimeout(resolve, 200));
        // Request distance reading (async response)
        this.sendCommand(CMD.ULTRASONIC, 1);
        readings.push({ angle });
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Return to center
      this.sendCommand(CMD.SERVO, 1, 90);

      return {
        success: true,
        cmd: "scan",
        data: {
          readings,
          note: "Distance values arrive asynchronously - check 'message' events"
        },
      };
    } catch (error) {
      return {
        success: false,
        cmd: "scan",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getStatus(): Promise<RobotResponse> {
    try {
      // Request ground check status
      this.sendCommand(CMD.GROUND_CHECK);
      return {
        success: true,
        cmd: "status",
        data: {
          connected: this.status.connected,
          mode: "stock",
          note: "Ground check response arrives asynchronously",
        },
      };
    } catch (error) {
      return {
        success: true,
        cmd: "status",
        data: {
          connected: this.status.connected,
          mode: "stock",
        },
      };
    }
  }

  async setMode(
    mode: "manual" | "explore" | "line_follow" | "obstacle_avoid"
  ): Promise<RobotResponse> {
    try {
      // For stock firmware, we just enter standby for manual mode
      // Other modes would require specific autonomous mode commands
      // which aren't well-documented in the stock protocol
      this.sendCommand(CMD.STANDBY);
      return {
        success: true,
        cmd: "set_mode",
        data: {
          mode,
          note: mode === "manual" ? "Entered standby mode" : "Autonomous modes not fully supported with stock firmware"
        }
      };
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
