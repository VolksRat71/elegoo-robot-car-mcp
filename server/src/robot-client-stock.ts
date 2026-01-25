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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private status: RobotStatus = { connected: false };
  private responseBuffer: string = "";
  private pendingResponse: ((value: string) => void) | null = null;
  private lastDistance: number = 999; // Last known distance reading

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

        // Enable TCP keepalive to prevent robot from dropping idle connections
        // Sends probe after 1 second of inactivity
        this.socket!.setKeepAlive(true, 1000);
        // Disable Nagle's algorithm for faster command transmission
        this.socket!.setNoDelay(true);

        this.emit("connected");
        console.error(`Connected to robot at ${this.robotHost}:${this.robotPort}`);

        // Start application-level heartbeat to keep connection active
        this.startHeartbeat();

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
    // Process incoming data - can be JSON or Elegoo format like {1_ok}, {distance:XX}
    const lines = this.responseBuffer.split("\n");
    this.responseBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip heartbeats
      if (trimmed === "{Heartbeat}") continue;

      console.error(`Received: ${trimmed}`);

      // Parse Elegoo format responses like {distance:XX} or {1_XX_YY_ZZ}
      // Ultrasonic returns format like {1_distance} where distance is the value
      const distanceMatch = trimmed.match(/\{1[_:](\d+)\}/);
      if (distanceMatch) {
        const value = parseInt(distanceMatch[1], 10);
        // If value looks like a distance (reasonable range), store it
        if (value >= 0 && value < 500) {
          this.lastDistance = value;
          this.emit("distance", value);
        }
      }

      // Resolve any pending response
      if (this.pendingResponse) {
        this.pendingResponse(trimmed);
        this.pendingResponse = null;
      }

      // Emit for other handlers
      this.emit("rawData", trimmed);
    }
  }

  private startReconnect(): void {
    if (this.reconnectInterval) return;

    // Stop heartbeat when disconnected
    this.stopHeartbeat();

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

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    // Send a lightweight status check every 3 seconds to keep connection alive
    // The Elegoo firmware seems to close idle connections
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && this.status.connected) {
        try {
          // Request ground check - lightweight command that won't affect robot state
          this.sendCommand(CMD.GROUND_CHECK);
        } catch {
          // If send fails, connection is dead - will trigger close event
        }
      }
    }, 3000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  async ensureConnected(): Promise<void> {
    if (this.socket && this.status.connected) return;

    console.error("Not connected, attempting to reconnect...");
    await this.connect();

    // Wait a moment for connection to establish
    await new Promise(resolve => setTimeout(resolve, 300));

    if (!this.status.connected) {
      throw new Error("Not connected to robot - make sure you're on ELEGOO WiFi");
    }
  }

  private sendCommand(n: number, d1?: number, d2?: number, d3?: number, d4?: number): void {
    if (!this.socket || !this.status.connected) {
      throw new Error("Not connected to robot");
    }

    // H must be string "1" per Elegoo protocol
    const cmd: Record<string, string | number> = { H: "1", N: n };
    // Include parameters if they were explicitly provided (even if 0)
    if (d1 !== undefined) cmd.D1 = d1;
    if (d2 !== undefined) cmd.D2 = d2;
    if (d3 !== undefined) cmd.D3 = d3;
    if (d4 !== undefined) cmd.D4 = d4;

    const message = JSON.stringify(cmd) + "\n";
    this.socket.write(message);
    console.error(`Sent: ${message.trim()}`);
  }

  private async sendCommandAndWait(n: number, d1?: number, d2?: number, d3?: number, d4?: number, timeout: number = 1000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        resolve("timeout");
      }, timeout);

      this.pendingResponse = (response: string) => {
        clearTimeout(timer);
        resolve(response);
      };

      this.sendCommand(n, d1, d2, d3, d4);
    });
  }

  // Movement commands
  async drive(
    direction: "forward" | "backward" | "left" | "right" | "stop",
    speed: number = 50,
    duration?: number
  ): Promise<RobotResponse> {
    // Ensure we're connected first
    await this.ensureConnected();

    // Convert 0-100 speed to 0-250 (Elegoo max)
    const mappedSpeed = Math.round((speed / 100) * 250);

    // N=1 Motor control: D1=motor(0=all), D2=speed(0-250), D3=direction(0=stop,1=fwd,2=back)
    // For turning, we control individual motors
    const MOTOR_DIR = { stop: 0, forward: 1, backward: 2 };

    try {
      // Enter standby first to clear any autonomous modes
      this.sendCommand(CMD.STANDBY);

      if (direction === "forward") {
        // All motors forward
        this.sendCommand(CMD.MOTOR_CONTROL, 0, mappedSpeed, MOTOR_DIR.forward);
      } else if (direction === "backward") {
        // All motors backward
        this.sendCommand(CMD.MOTOR_CONTROL, 0, mappedSpeed, MOTOR_DIR.backward);
      } else if (direction === "left") {
        // Right motor forward, left motor backward (spin left)
        this.sendCommand(CMD.MOTOR_CONTROL, 1, mappedSpeed, MOTOR_DIR.forward);  // Right forward
        this.sendCommand(CMD.MOTOR_CONTROL, 2, mappedSpeed, MOTOR_DIR.backward); // Left backward
      } else if (direction === "right") {
        // Left motor forward, right motor backward (spin right)
        this.sendCommand(CMD.MOTOR_CONTROL, 2, mappedSpeed, MOTOR_DIR.forward);  // Left forward
        this.sendCommand(CMD.MOTOR_CONTROL, 1, mappedSpeed, MOTOR_DIR.backward); // Right backward
      } else {
        // Stop all motors
        this.sendCommand(CMD.MOTOR_CONTROL, 0, 0, MOTOR_DIR.stop);
      }

      // If duration specified, stop after delay
      if (duration && direction !== "stop") {
        setTimeout(() => {
          this.sendCommand(CMD.MOTOR_CONTROL, 0, 0, MOTOR_DIR.stop);
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

  // Safe drive - obstacle detection currently disabled (sensor returning 0)
  // TODO: Debug ultrasonic sensor - always returns 0cm
  async safeDrive(
    direction: "forward" | "backward" | "left" | "right" | "stop",
    speed: number = 50,
    checkObstacles: boolean = false // Disabled by default until sensor is fixed
  ): Promise<RobotResponse> {
    // Only check for obstacles when enabled and moving forward
    if (checkObstacles && direction === "forward") {
      const hasObstacle = await this.hasObstacle();

      if (hasObstacle) {
        await this.emergencyStop();
        return {
          success: false,
          cmd: "safe_drive",
          error: "Obstacle detected ahead! Stopped for safety.",
          data: { obstacleDetected: true, blocked: true }
        };
      }
    }

    // Proceed with drive
    return this.drive(direction, speed);
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
      await this.ensureConnected();
      // Send stop command immediately using N=1 (motor control)
      // D1=0 (all motors), D2=0 (speed), D3=0 (stop)
      this.sendCommand(CMD.MOTOR_CONTROL, 0, 0, 0);
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
    await this.ensureConnected();
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
      // N=21: Ultrasonic sensor
      // D1=1 returns obstacle detection (true/false) - WORKING
      // D1=2 should return distance in cm - but seems broken on this firmware
      const response = await this.sendCommandAndWait(CMD.ULTRASONIC, 1, 500);

      // Parse obstacle detection response - format is {1_true} or {1_false}
      const hasObstacle = response.includes("true");

      // Return estimated distance based on obstacle detection
      // true = obstacle close (estimate 15cm), false = clear (estimate 100cm)
      const estimatedDistance = hasObstacle ? 15 : 100;
      this.lastDistance = estimatedDistance;

      return {
        success: true,
        cmd: "get_distance",
        data: {
          distance: estimatedDistance,
          obstacleDetected: hasObstacle,
          note: hasObstacle ? "Obstacle detected (close)" : "Path clear"
        }
      };
    } catch (error) {
      return {
        success: false,
        cmd: "get_distance",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Check if obstacle is detected (more reliable than distance)
  async hasObstacle(): Promise<boolean> {
    const response = await this.sendCommandAndWait(CMD.ULTRASONIC, 1, 500);
    return response.includes("true");
  }

  // Get last known distance without sending command
  getLastDistance(): number {
    return this.lastDistance;
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
    this.stopHeartbeat();
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
