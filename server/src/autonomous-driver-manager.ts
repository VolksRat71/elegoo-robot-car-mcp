/**
 * Autonomous Driver Manager
 *
 * Manages the Python autonomous driver process:
 * - Spawns Python process for vision-based driving
 * - Monitors output for status updates
 * - Handles graceful shutdown
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { EventEmitter } from "events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DriverStatus {
  running: boolean;
  startTime: number | null;
  duration_s: number | null;
  mode: "normal" | "cautious" | "dry-run" | null;
  lastOutput: string[];
  metrics: {
    commands_sent: number;
    success_rate: number;
    avg_latency_ms: number;
  } | null;
}

export interface DiagnosticsResult {
  success: boolean;
  duration_s: number;
  commands_sent: number;
  success_rate: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  max_latency_ms: number;
  connection_drops: number;
  recommendation: string;
  raw_output: string[];
}

export class AutonomousDriverManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private visionDir: string;
  private outputBuffer: string[] = [];
  private maxOutputLines = 100;
  private startTime: number | null = null;
  private currentMode: "normal" | "cautious" | "dry-run" | null = null;
  private requestedDuration: number | null = null;

  constructor() {
    super();
    this.visionDir = path.resolve(__dirname, "../../vision");
  }

  /**
   * Get the Python command to use (venv or system)
   */
  private getPythonCmd(): string {
    const venvPython = path.join(this.visionDir, "venv", "bin", "python");
    return fs.existsSync(venvPython) ? venvPython : "python3";
  }

  /**
   * Start the autonomous driver
   */
  async startDriver(options: {
    duration_s?: number;
    cautious?: boolean;
    dryRun?: boolean;
    robotHost?: string;
  } = {}): Promise<{ success: boolean; message: string }> {
    if (this.process) {
      return { success: false, message: "Autonomous driver already running" };
    }

    const duration = options.duration_s ?? 30;
    const cautious = options.cautious ?? false;
    const dryRun = options.dryRun ?? false;
    const robotHost = options.robotHost ?? "192.168.4.1";

    // Build command args
    const args = ["autonomous_driver.py", "--duration", String(duration)];
    if (cautious) args.push("--cautious");
    if (dryRun) args.push("--dry-run");
    args.push("--robot-host", robotHost);

    this.currentMode = dryRun ? "dry-run" : (cautious ? "cautious" : "normal");
    this.requestedDuration = duration;

    const pythonCmd = this.getPythonCmd();
    console.error(`[DriverManager] Starting: ${pythonCmd} ${args.join(" ")}`);

    try {
      this.process = spawn(pythonCmd, args, {
        cwd: this.visionDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.startTime = Date.now();
      this.outputBuffer = [];

      // Handle stdout
      this.process.stdout?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Driver] ${line}`);
          this.addOutput(line);
          this.emit("output", line);
        }
      });

      // Handle stderr
      this.process.stderr?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Driver] ${line}`);
          this.addOutput(line);
          this.emit("output", line);
        }
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        console.error(`[DriverManager] Process exited with code ${code}, signal ${signal}`);
        const wasRunning = this.process !== null;
        this.process = null;

        if (wasRunning) {
          this.emit("stopped", { code, signal, output: this.outputBuffer });
        }
      });

      // Handle errors
      this.process.on("error", (err) => {
        console.error(`[DriverManager] Process error: ${err.message}`);
        this.emit("error", err);
      });

      return {
        success: true,
        message: `Autonomous driver started (${this.currentMode} mode, ${duration}s)`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to start driver: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Stop the autonomous driver
   */
  async stopDriver(): Promise<{ success: boolean; message: string }> {
    if (!this.process) {
      return { success: false, message: "Autonomous driver not running" };
    }

    console.error("[DriverManager] Stopping autonomous driver...");

    // Send SIGINT for graceful shutdown (triggers summary output)
    this.process.kill("SIGINT");

    // Wait up to 5 seconds for graceful shutdown
    const stopped = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          console.error("[DriverManager] Force killing driver");
          this.process.kill("SIGKILL");
        }
        resolve(false);
      }, 5000);

      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      if (this.process) {
        this.process.once("exit", onExit);
      } else {
        clearTimeout(timeout);
        resolve(true);
      }
    });

    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    this.startTime = null;
    this.currentMode = null;

    return {
      success: true,
      message: stopped
        ? `Autonomous driver stopped gracefully after ${elapsed.toFixed(1)}s`
        : `Autonomous driver force-stopped after ${elapsed.toFixed(1)}s`,
    };
  }

  /**
   * Run connection diagnostics
   */
  async runDiagnostics(options: {
    duration_s?: number;
    interval_s?: number;
    robotHost?: string;
  } = {}): Promise<DiagnosticsResult> {
    const duration = options.duration_s ?? 30;
    const interval = options.interval_s ?? 0.5;
    const robotHost = options.robotHost ?? "192.168.4.1";

    const pythonCmd = this.getPythonCmd();
    const args = [
      "connection_diagnostics.py",
      "--duration", String(duration),
      "--interval", String(interval),
      "--host", robotHost,
    ];

    console.error(`[DriverManager] Running diagnostics: ${pythonCmd} ${args.join(" ")}`);

    return new Promise((resolve) => {
      const output: string[] = [];
      const proc = spawn(pythonCmd, args, {
        cwd: this.visionDir,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Diag] ${line}`);
          output.push(line);
        }
      });

      proc.stderr?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Diag] ${line}`);
          output.push(line);
        }
      });

      proc.on("exit", () => {
        // Parse output for metrics
        const result = this.parseDiagnosticsOutput(output, duration);
        resolve(result);
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          duration_s: duration,
          commands_sent: 0,
          success_rate: 0,
          avg_latency_ms: 0,
          p95_latency_ms: 0,
          max_latency_ms: 0,
          connection_drops: 0,
          recommendation: `Diagnostics failed: ${err.message}`,
          raw_output: output,
        });
      });
    });
  }

  /**
   * Parse diagnostics output for metrics
   */
  private parseDiagnosticsOutput(output: string[], duration: number): DiagnosticsResult {
    const result: DiagnosticsResult = {
      success: true,
      duration_s: duration,
      commands_sent: 0,
      success_rate: 0,
      avg_latency_ms: 0,
      p95_latency_ms: 0,
      max_latency_ms: 0,
      connection_drops: 0,
      recommendation: "",
      raw_output: output,
    };

    // Parse key metrics from output
    for (const line of output) {
      if (line.includes("Total sent:")) {
        const match = line.match(/Total sent:\s+(\d+)/);
        if (match) result.commands_sent = parseInt(match[1]);
      }
      if (line.includes("Success rate:")) {
        const match = line.match(/Success rate:\s+([\d.]+)%/);
        if (match) result.success_rate = parseFloat(match[1]);
      }
      if (line.includes("Avg:") && line.includes("ms")) {
        const match = line.match(/Avg:\s+([\d.]+)/);
        if (match) result.avg_latency_ms = parseFloat(match[1]);
      }
      if (line.includes("P95:")) {
        const match = line.match(/P95:\s+([\d.]+)/);
        if (match) result.p95_latency_ms = parseFloat(match[1]);
      }
      if (line.includes("Max:") && !line.includes("Maximum")) {
        const match = line.match(/Max:\s+([\d.]+)/);
        if (match) result.max_latency_ms = parseFloat(match[1]);
      }
      if (line.includes("Drops:")) {
        const match = line.match(/Drops:\s+(\d+)/);
        if (match) result.connection_drops = parseInt(match[1]);
      }
      if (line.includes("Connection quality:")) {
        result.recommendation = line.trim();
      }
    }

    // Generate recommendation if not found
    if (!result.recommendation) {
      if (result.success_rate >= 95 && result.avg_latency_ms < 50) {
        result.recommendation = "✅ Connection quality: GOOD - suitable for autonomous driving";
      } else if (result.success_rate >= 85 && result.avg_latency_ms < 100) {
        result.recommendation = "⚠️ Connection quality: FAIR - use cautious settings";
      } else {
        result.recommendation = "❌ Connection quality: POOR - fix connection before driving";
      }
    }

    return result;
  }

  /**
   * Get current driver status
   */
  getStatus(): DriverStatus {
    const running = this.process !== null;
    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : null;

    // Try to parse metrics from recent output
    let metrics = null;
    if (running) {
      // Look for recent command stats in output
      for (let i = this.outputBuffer.length - 1; i >= 0; i--) {
        const line = this.outputBuffer[i];
        if (line.includes("sent:") && line.includes("ok:")) {
          const sentMatch = line.match(/sent:(\d+)/);
          const okMatch = line.match(/ok:(\d+)/);
          if (sentMatch && okMatch) {
            const sent = parseInt(sentMatch[1]);
            const ok = parseInt(okMatch[1]);
            metrics = {
              commands_sent: sent,
              success_rate: sent > 0 ? (ok / sent) * 100 : 0,
              avg_latency_ms: 0, // Would need to parse more carefully
            };
            break;
          }
        }
      }
    }

    return {
      running,
      startTime: this.startTime,
      duration_s: this.requestedDuration,
      mode: this.currentMode,
      lastOutput: this.outputBuffer.slice(-10),
      metrics,
    };
  }

  /**
   * Check if driver is running
   */
  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Add line to output buffer (with size limit)
   */
  private addOutput(line: string): void {
    this.outputBuffer.push(line);
    if (this.outputBuffer.length > this.maxOutputLines) {
      this.outputBuffer.shift();
    }
  }
}

// Singleton instance
let managerInstance: AutonomousDriverManager | null = null;

export function getAutonomousDriverManager(): AutonomousDriverManager {
  if (!managerInstance) {
    managerInstance = new AutonomousDriverManager();
  }
  return managerInstance;
}
