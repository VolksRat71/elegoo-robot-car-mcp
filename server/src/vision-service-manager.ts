/**
 * Vision Service Manager
 *
 * Manages the Python vision sidecar service lifecycle:
 * - Spawns Python process on startup
 * - Monitors health and restarts if needed
 * - Cleans up on shutdown
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vision service configuration
const VISION_HOST = process.env.VISION_HOST || "127.0.0.1";
const VISION_PORT = parseInt(process.env.VISION_PORT || "8765");
const VISION_URL = `http://${VISION_HOST}:${VISION_PORT}`;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const STARTUP_TIMEOUT = 120000; // 2 minutes for model loading
const RESTART_DELAY = 5000; // 5 seconds before restart attempt

export class VisionServiceManager {
  private process: ChildProcess | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private restartCount = 0;
  private maxRestarts = 3;
  private visionDir: string;

  constructor() {
    // Vision directory is at ../../../vision relative to compiled JS in dist/
    // or ../../vision relative to src/
    this.visionDir = path.resolve(__dirname, "../../vision");
  }

  /**
   * Start the vision service
   */
  async start(): Promise<boolean> {
    if (this.process) {
      console.error("[VisionManager] Service already running");
      return true;
    }

    console.error(`[VisionManager] Starting vision service from ${this.visionDir}`);

    // Check if vision directory exists
    const fs = await import("fs");
    if (!fs.existsSync(this.visionDir)) {
      console.error(`[VisionManager] Vision directory not found: ${this.visionDir}`);
      return false;
    }

    // Check for venv
    const venvPython = path.join(this.visionDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    console.error(`[VisionManager] Using Python: ${pythonCmd}`);

    try {
      // Spawn Python process
      this.process = spawn(pythonCmd, ["main.py"], {
        cwd: this.visionDir,
        env: {
          ...process.env,
          VISION_HOST: VISION_HOST,
          VISION_PORT: String(VISION_PORT),
          PYTHONUNBUFFERED: "1", // Ensure output is not buffered
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Handle stdout
      this.process.stdout?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Vision] ${line}`);
        }
      });

      // Handle stderr
      this.process.stderr?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`[Vision] ${line}`);
        }
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        console.error(`[VisionManager] Process exited with code ${code}, signal ${signal}`);
        this.process = null;

        if (!this.isShuttingDown && this.restartCount < this.maxRestarts) {
          this.restartCount++;
          console.error(
            `[VisionManager] Attempting restart ${this.restartCount}/${this.maxRestarts} in ${RESTART_DELAY}ms`
          );
          setTimeout(() => this.start(), RESTART_DELAY);
        }
      });

      // Handle errors
      this.process.on("error", (err) => {
        console.error(`[VisionManager] Process error: ${err.message}`);
      });

      // Wait for service to be ready
      const ready = await this.waitForReady();
      if (ready) {
        console.error("[VisionManager] Vision service ready!");
        this.restartCount = 0; // Reset restart count on successful start
        this.startHealthCheck();
        return true;
      } else {
        console.error("[VisionManager] Vision service failed to start within timeout");
        this.stop();
        return false;
      }
    } catch (error) {
      console.error(`[VisionManager] Failed to spawn process: ${error}`);
      return false;
    }
  }

  /**
   * Wait for the service to be ready (health check passes)
   */
  private async waitForReady(): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    while (Date.now() - startTime < STARTUP_TIMEOUT) {
      if (!this.process) {
        return false; // Process died
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${VISION_URL}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = (await response.json()) as { models_loaded?: boolean };
          if (data.models_loaded) {
            return true;
          }
        }
      } catch {
        // Service not ready yet, keep waiting
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      if (this.isShuttingDown || !this.process) return;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${VISION_URL}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          console.error("[VisionManager] Health check failed - service unhealthy");
        }
      } catch {
        console.error("[VisionManager] Health check failed - service unreachable");
        // Process exit handler will trigger restart
        if (this.process) {
          this.process.kill();
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  /**
   * Stop the vision service
   */
  stop(): void {
    this.isShuttingDown = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.process) {
      console.error("[VisionManager] Stopping vision service...");
      this.process.kill("SIGTERM");

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process) {
          console.error("[VisionManager] Force killing vision service");
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Get the vision service URL
   */
  getUrl(): string {
    return VISION_URL;
  }
}

// Singleton instance
let managerInstance: VisionServiceManager | null = null;

export function getVisionServiceManager(): VisionServiceManager {
  if (!managerInstance) {
    managerInstance = new VisionServiceManager();
  }
  return managerInstance;
}
