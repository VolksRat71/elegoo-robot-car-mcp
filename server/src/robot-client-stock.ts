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

// Type for queued commands
interface QueuedCommand {
  execute: () => Promise<void>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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

  // Command queue to serialize all robot commands
  private commandQueue: QueuedCommand[] = [];
  private isProcessingQueue = false;
  private isReconnecting = false;

  constructor(host: string = "192.168.4.1", port: number = 100) {
    super();
    this.robotHost = host;
    this.robotPort = port;
  }

  /**
   * Queue a command for execution. Only one command runs at a time.
   * Commands are rejected if disconnected.
   */
  private async queueCommand<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      // Reject immediately if we're reconnecting
      if (this.isReconnecting) {
        reject(new Error("Connection lost - reconnecting..."));
        return;
      }

      const command: QueuedCommand = {
        execute: async () => {
          try {
            const result = await fn();
            resolve(result as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      this.commandQueue.push(command);
      this.processQueue();
    });
  }

  /**
   * Process queued commands one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.isReconnecting) return;
    if (this.commandQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.commandQueue.length > 0 && !this.isReconnecting) {
      const command = this.commandQueue.shift();
      if (!command) continue;

      try {
        await command.execute();
      } catch (error) {
        // Error already handled in execute wrapper
      }

      // Small delay between commands for robot stability
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.isProcessingQueue = false;
  }

  /**
   * Reject all queued commands (called during reconnection)
   */
  private rejectQueuedCommands(reason: string): void {
    const queue = this.commandQueue;
    this.commandQueue = [];
    for (const cmd of queue) {
      cmd.reject(new Error(reason));
    }
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

        // Mark as disconnected and trigger reconnection
        const wasConnected = this.status.connected;
        this.status.connected = false;

        if (!wasConnected) {
          // Initial connection failed
          reject(err);
        } else {
          // Connection was established, now lost - start reconnecting
          this.startReconnect();
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
    if (this.isReconnecting) return;

    this.isReconnecting = true;

    // Stop heartbeat when disconnected
    this.stopHeartbeat();

    // Reject any queued commands - they can't complete without connection
    this.rejectQueuedCommands("Connection lost - reconnecting...");

    this.reconnectInterval = setInterval(async () => {
      console.error("Attempting to reconnect to robot...");
      try {
        // Temporarily clear reconnecting flag to allow connect()
        this.isReconnecting = false;
        await this.connect();

        // Success - clear interval
        if (this.reconnectInterval) {
          clearInterval(this.reconnectInterval);
          this.reconnectInterval = null;
        }
        console.error("Reconnection successful");
        this.emit("reconnected");
      } catch {
        // Failed - set flag back and retry
        this.isReconnecting = true;
      }
    }, 5000);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    // Send a lightweight status check every 10 seconds to keep connection alive
    // Increased from 3s to reduce interference with command queue
    this.heartbeatInterval = setInterval(() => {
      // Skip heartbeat if queue is busy processing commands
      if (this.isProcessingQueue) return;
      // Skip if reconnecting
      if (this.isReconnecting) return;

      if (this.socket && this.status.connected) {
        try {
          // Request ground check - lightweight command that won't affect robot state
          this.sendCommandRaw(CMD.GROUND_CHECK);
        } catch (err) {
          // If send fails, connection is dead - mark disconnected and reconnect
          console.error("Heartbeat failed:", err instanceof Error ? err.message : "Unknown error");
          this.status.connected = false;
          this.startReconnect();
        }
      }
    }, 10000);
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

  /**
   * Raw command send - used internally by heartbeat and queued commands.
   * Wraps socket.write with error handling.
   */
  private sendCommandRaw(n: number, d1?: number, d2?: number, d3?: number, d4?: number): void {
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

    try {
      this.socket.write(message);
      console.error(`Sent: ${message.trim()}`);
    } catch (err) {
      // Write failed - connection is broken
      console.error("Socket write failed:", err instanceof Error ? err.message : "Unknown error");
      this.status.connected = false;
      this.startReconnect();
      throw err;
    }
  }

  /**
   * Send command via the queue (used by public API methods)
   */
  private sendCommand(n: number, d1?: number, d2?: number, d3?: number, d4?: number): void {
    // For synchronous callers, we still send immediately but wrapped in error handling
    // Most callers will migrate to async methods that use queueCommand
    this.sendCommandRaw(n, d1, d2, d3, d4);
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

      try {
        this.sendCommandRaw(n, d1, d2, d3, d4);
      } catch (err) {
        clearTimeout(timer);
        this.pendingResponse = null;
        reject(err);
      }
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

    // Queue the entire drive operation as an atomic unit
    return this.queueCommand(async () => {
      // Convert 0-100 speed to 0-250 (Elegoo max)
      const mappedSpeed = Math.round((speed / 100) * 250);

      // N=1 Motor control: D1=motor(0=all), D2=speed(0-250), D3=direction(0=stop,1=fwd,2=back)
      // For turning, we control individual motors
      const MOTOR_DIR = { stop: 0, forward: 1, backward: 2 };

      try {
        // Enter standby first to clear any autonomous modes
        this.sendCommandRaw(CMD.STANDBY);

        if (direction === "forward") {
          // All motors forward
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 0, mappedSpeed, MOTOR_DIR.forward);
        } else if (direction === "backward") {
          // All motors backward
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 0, mappedSpeed, MOTOR_DIR.backward);
        } else if (direction === "left") {
          // Right motor forward, left motor backward (spin left)
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 1, mappedSpeed, MOTOR_DIR.forward);  // Right forward
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 2, mappedSpeed, MOTOR_DIR.backward); // Left backward
        } else if (direction === "right") {
          // Left motor forward, right motor backward (spin right)
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 2, mappedSpeed, MOTOR_DIR.forward);  // Left forward
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 1, mappedSpeed, MOTOR_DIR.backward); // Right backward
        } else {
          // Stop all motors
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 0, 0, MOTOR_DIR.stop);
        }

        // If duration specified, wait then stop (within the queued command)
        if (duration && direction !== "stop") {
          await new Promise(resolve => setTimeout(resolve, duration));
          this.sendCommandRaw(CMD.MOTOR_CONTROL, 0, 0, MOTOR_DIR.stop);
        }

        return { success: true, cmd: "drive", data: { direction, speed, mappedSpeed } } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "drive",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
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
    await this.ensureConnected();

    return this.queueCommand(async () => {
      const mappedSpeed = Math.round((speed / 100) * 250);

      // Estimate duration based on degrees (rough approximation)
      const duration = Math.abs(degrees) * 10; // ~10ms per degree at full speed

      try {
        // Enter standby first
        this.sendCommandRaw(CMD.STANDBY);

        // Use N=3 with left/right direction
        const direction = degrees > 0 ? DIR.RIGHT : DIR.LEFT;
        this.sendCommandRaw(CMD.CAR_DIRECTION, direction, mappedSpeed);

        // Wait for turn duration then stop (within queued command)
        await new Promise(resolve => setTimeout(resolve, duration));
        this.sendCommandRaw(CMD.CAR_DIRECTION, DIR.STOP, 0);

        return { success: true, cmd: "turn", data: { degrees, speed, mappedSpeed } } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "turn",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  async emergencyStop(): Promise<RobotResponse> {
    try {
      // Emergency stop bypasses the queue for immediate response
      if (!this.socket || !this.status.connected) {
        return { success: false, cmd: "emergency_stop", error: "Not connected" };
      }

      // Send stop command immediately using N=1 (motor control)
      // D1=0 (all motors), D2=0 (speed), D3=0 (stop)
      this.sendCommandRaw(CMD.MOTOR_CONTROL, 0, 0, 0);
      // Also enter standby to halt any autonomous modes
      this.sendCommandRaw(CMD.STANDBY);

      // Clear the command queue to prevent further movement
      this.rejectQueuedCommands("Emergency stop - queue cleared");

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

    return this.queueCommand(async () => {
      // Servo angle: 0-180 degrees
      const clampedAngle = Math.max(0, Math.min(180, angle));

      try {
        // N=5: Servo control - D1=servo(1=pan), D2=angle
        // **CONFIRMED WORKING** in testing
        this.sendCommandRaw(CMD.SERVO, 1, clampedAngle);
        return { success: true, cmd: "look", data: { angle: clampedAngle } } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "look",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  async getDistance(): Promise<RobotResponse> {
    await this.ensureConnected();

    return this.queueCommand(async () => {
      try {
        // N=21: Ultrasonic sensor
        // D1=1 returns obstacle detection (true/false) - WORKING
        // D1=2 should return distance in cm - but seems broken on this firmware
        const response = await this.sendCommandAndWait(CMD.ULTRASONIC, 1, undefined, undefined, undefined, 500);

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
        } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "get_distance",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  // Check if obstacle is detected (more reliable than distance)
  async hasObstacle(): Promise<boolean> {
    if (!this.status.connected) return false;

    return this.queueCommand(async () => {
      const response = await this.sendCommandAndWait(CMD.ULTRASONIC, 1, undefined, undefined, undefined, 500);
      return response.includes("true");
    });
  }

  // Get last known distance without sending command
  getLastDistance(): number {
    return this.lastDistance;
  }

  async getLineSensors(): Promise<RobotResponse> {
    await this.ensureConnected();

    return this.queueCommand(async () => {
      try {
        // N=22: Line tracking sensor - D1=1
        this.sendCommandRaw(CMD.LINE_TRACKING, 1);
        return {
          success: true,
          cmd: "get_line_sensors",
          data: { note: "Response arrives asynchronously - listen for 'message' event" }
        } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "get_line_sensors",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  async setLed(r: number, g: number, b: number, led: number = 0): Promise<RobotResponse> {
    await this.ensureConnected();

    return this.queueCommand(async () => {
      try {
        // N=8: LED control - D1=led(0=all), D2=R, D3=G, D4=B
        this.sendCommandRaw(CMD.LED, led, r, g, b);
        return { success: true, cmd: "set_led", data: { r, g, b, led } } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "set_led",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
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
    await this.ensureConnected();

    // Queue the entire scan operation as atomic
    return this.queueCommand(async () => {
      // Implement scan by panning servo and reading ultrasonic at each step
      // This is a software-level implementation using basic commands
      try {
        const readings: Array<{ angle: number; distance?: number }> = [];

        for (let angle = startAngle; angle <= endAngle; angle += step) {
          // Check connection before each step
          if (!this.status.connected) {
            return {
              success: false,
              cmd: "scan",
              error: "Connection lost during scan",
              data: { partialReadings: readings }
            } as RobotResponse;
          }

          // Pan to angle
          this.sendCommandRaw(CMD.SERVO, 1, angle);
          // Wait for servo to move
          await new Promise(resolve => setTimeout(resolve, 200));
          // Request distance reading (async response)
          this.sendCommandRaw(CMD.ULTRASONIC, 1);
          readings.push({ angle });
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Return to center
        this.sendCommandRaw(CMD.SERVO, 1, 90);

        return {
          success: true,
          cmd: "scan",
          data: {
            readings,
            note: "Distance values arrive asynchronously - check 'message' events"
          },
        } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "scan",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  async getStatus(): Promise<RobotResponse> {
    // Status can be returned without queueing - it's informational
    const statusData = {
      connected: this.status.connected,
      mode: "stock",
      queueLength: this.commandQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      isReconnecting: this.isReconnecting,
    };

    // If connected, try to send a ground check (but don't fail if it errors)
    if (this.status.connected && !this.isReconnecting) {
      try {
        this.sendCommandRaw(CMD.GROUND_CHECK);
      } catch {
        // Ignore - status still valid
      }
    }

    return {
      success: true,
      cmd: "status",
      data: statusData,
    };
  }

  async setMode(
    mode: "manual" | "explore" | "line_follow" | "obstacle_avoid"
  ): Promise<RobotResponse> {
    await this.ensureConnected();

    return this.queueCommand(async () => {
      try {
        // For stock firmware, we just enter standby for manual mode
        // Other modes would require specific autonomous mode commands
        // which aren't well-documented in the stock protocol
        this.sendCommandRaw(CMD.STANDBY);
        return {
          success: true,
          cmd: "set_mode",
          data: {
            mode,
            note: mode === "manual" ? "Entered standby mode" : "Autonomous modes not fully supported with stock firmware"
          }
        } as RobotResponse;
      } catch (error) {
        return {
          success: false,
          cmd: "set_mode",
          error: error instanceof Error ? error.message : "Unknown error",
        } as RobotResponse;
      }
    });
  }

  getConnectionStatus(): RobotStatus {
    return { ...this.status };
  }

  disconnect(): void {
    this.stopHeartbeat();

    // Clear reconnection attempts
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.isReconnecting = false;

    // Reject all queued commands
    this.rejectQueuedCommands("Disconnected");

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
