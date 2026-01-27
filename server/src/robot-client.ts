/**
 * Robot Client - Unified interface for robot communication
 *
 * Supports two modes controlled by ROBOT_MODE env var:
 * - "proxy" (default): Routes commands through Python service for centralized connection management
 * - "direct": Direct TCP to robot (legacy mode)
 *
 * The proxy mode is recommended because it centralizes all connection management
 * in one place (Python) and handles the ESP32 reconnect-every-3 pattern consistently.
 */

import { RobotProxy, getRobotProxy } from "./robot-proxy.js";
import {
  StockRobotClient,
  getStockRobotClient,
  type RobotResponse,
  type RobotStatus,
} from "./robot-client-stock.js";

// Re-export types
export type { RobotResponse, RobotStatus };

// Union type for both client implementations
export type RobotClient = RobotProxy | StockRobotClient;

// Singleton instance
let clientInstance: RobotClient | null = null;

/**
 * Get the robot client instance.
 *
 * Uses proxy mode by default (routes through Python service).
 * Set ROBOT_MODE=direct to use direct TCP connection.
 */
export function getRobotClient(
  host?: string,
  port?: number
): RobotClient {
  if (clientInstance) {
    return clientInstance;
  }

  const mode = process.env.ROBOT_MODE || "proxy";
  const visionUrl = process.env.VISION_SERVICE_URL || "http://localhost:8765";

  if (mode === "proxy") {
    console.error(`[RobotClient] Using proxy mode (via ${visionUrl})`);
    clientInstance = getRobotProxy(visionUrl);
  } else {
    console.error(`[RobotClient] Using direct TCP mode`);
    const robotHost = host || process.env.ROBOT_HOST || "192.168.4.1";
    const robotPort = port || parseInt(process.env.ROBOT_PORT || "100");
    clientInstance = getStockRobotClient(robotHost, robotPort);
  }

  return clientInstance;
}

// Also export for explicit access
export { RobotProxy, getRobotProxy } from "./robot-proxy.js";
export { StockRobotClient, getStockRobotClient } from "./robot-client-stock.js";
