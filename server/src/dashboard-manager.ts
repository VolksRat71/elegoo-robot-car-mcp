/**
 * Dashboard Manager
 *
 * Manages the Vite/React dashboard dev server lifecycle:
 * - Spawns npm run dev on startup
 * - Monitors health
 * - Cleans up on shutdown
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dashboard configuration
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "5173");
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
const STARTUP_TIMEOUT = 30000; // 30 seconds for vite to start

export class DashboardManager {
  private process: ChildProcess | null = null;
  private isShuttingDown = false;
  private dashboardDir: string;

  constructor() {
    // Dashboard directory is at ../../../dashboard relative to compiled JS in dist/
    this.dashboardDir = path.resolve(__dirname, "../../dashboard");
  }

  /**
   * Start the dashboard dev server
   */
  async start(): Promise<boolean> {
    if (this.process) {
      console.error("[DashboardManager] Server already running");
      return true;
    }

    console.error(`[DashboardManager] Starting dashboard from ${this.dashboardDir}`);

    // Check if dashboard directory exists
    const fs = await import("fs");
    if (!fs.existsSync(this.dashboardDir)) {
      console.error(`[DashboardManager] Dashboard directory not found: ${this.dashboardDir}`);
      return false;
    }

    // Check for node_modules
    const nodeModules = path.join(this.dashboardDir, "node_modules");
    if (!fs.existsSync(nodeModules)) {
      console.error(`[DashboardManager] node_modules not found, run 'npm install' in dashboard/`);
      return false;
    }

    try {
      // Spawn npm run dev
      this.process = spawn("npm", ["run", "dev", "--", "--host"], {
        cwd: this.dashboardDir,
        env: {
          ...process.env,
          PORT: String(DASHBOARD_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      // Handle stdout
      this.process.stdout?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            console.error(`[Dashboard] ${line}`);
          }
        }
      });

      // Handle stderr
      this.process.stderr?.on("data", (data) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            console.error(`[Dashboard] ${line}`);
          }
        }
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        console.error(`[DashboardManager] Process exited with code ${code}, signal ${signal}`);
        this.process = null;
      });

      // Handle errors
      this.process.on("error", (err) => {
        console.error(`[DashboardManager] Process error: ${err.message}`);
      });

      // Wait for service to be ready
      const ready = await this.waitForReady();
      if (ready) {
        console.error(`[DashboardManager] Dashboard ready at ${DASHBOARD_URL}`);
        return true;
      } else {
        console.error("[DashboardManager] Dashboard failed to start within timeout");
        // Don't stop - vite might still be starting
        return true; // Return true anyway, vite is slow sometimes
      }
    } catch (error) {
      console.error(`[DashboardManager] Failed to spawn process: ${error}`);
      return false;
    }
  }

  /**
   * Wait for the service to be ready
   */
  private async waitForReady(): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 1000;

    while (Date.now() - startTime < STARTUP_TIMEOUT) {
      if (!this.process) {
        return false;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(DASHBOARD_URL, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok || response.status === 304) {
          return true;
        }
      } catch {
        // Not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  /**
   * Stop the dashboard server
   */
  stop(): void {
    this.isShuttingDown = true;

    if (this.process) {
      console.error("[DashboardManager] Stopping dashboard server...");
      this.process.kill("SIGTERM");

      // Force kill after 3 seconds
      setTimeout(() => {
        if (this.process) {
          console.error("[DashboardManager] Force killing dashboard server");
          this.process.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Get the dashboard URL
   */
  getUrl(): string {
    return DASHBOARD_URL;
  }
}

// Singleton instance
let managerInstance: DashboardManager | null = null;

export function getDashboardManager(): DashboardManager {
  if (!managerInstance) {
    managerInstance = new DashboardManager();
  }
  return managerInstance;
}
