/**
 * Autonomy MCP Tools
 *
 * Tools for vision-based autonomous driving:
 * - start_vision_driver: Start Python autonomous driver
 * - stop_vision_driver: Stop the driver
 * - driver_status: Get current driver status
 * - run_diagnostics: Test connection quality
 */

import { z } from "zod";
import { getAutonomousDriverManager } from "../autonomous-driver-manager.js";

// ============================================================================
// start_vision_driver - Start autonomous vision-based driving
// ============================================================================

export const startVisionDriverSchema = z.object({
  duration_s: z
    .number()
    .min(5)
    .max(300)
    .default(30)
    .describe("Duration to drive in seconds (5-300)"),
  cautious: z
    .boolean()
    .default(false)
    .describe("Use cautious settings (slower speeds, lower thresholds)"),
  dry_run: z
    .boolean()
    .default(false)
    .describe("Dry run mode - decision logic only, no motor commands"),
});

export async function startVisionDriver(
  params: z.infer<typeof startVisionDriverSchema>
): Promise<string> {
  const manager = getAutonomousDriverManager();

  const result = await manager.startDriver({
    duration_s: params.duration_s,
    cautious: params.cautious,
    dryRun: params.dry_run,
  });

  if (result.success) {
    return `${result.message}

The driver runs independently with a tight control loop (300ms).
Use 'stop_vision_driver' to stop early, or 'driver_status' to check progress.

Thresholds:
- CLEAR: <25% depth = safe to proceed
- OBSTACLE: >40% depth = turn to avoid
- DANGER: >60% depth = stop immediately

Mode: ${params.dry_run ? "DRY-RUN (no motors)" : params.cautious ? "CAUTIOUS" : "NORMAL"}`;
  }

  return result.message;
}

// ============================================================================
// stop_vision_driver - Stop the autonomous driver
// ============================================================================

export const stopVisionDriverSchema = z.object({});

export async function stopVisionDriver(): Promise<string> {
  const manager = getAutonomousDriverManager();
  const result = await manager.stopDriver();
  return result.message;
}

// ============================================================================
// driver_status - Get current driver status
// ============================================================================

export const driverStatusSchema = z.object({});

export async function driverStatus(): Promise<string> {
  const manager = getAutonomousDriverManager();
  const status = manager.getStatus();

  if (!status.running) {
    return "Vision driver not running.";
  }

  const elapsed = status.startTime
    ? ((Date.now() - status.startTime) / 1000).toFixed(1)
    : "?";

  let output = `Vision Driver Status:
- Running: YES
- Mode: ${status.mode}
- Elapsed: ${elapsed}s / ${status.duration_s}s
`;

  if (status.metrics) {
    output += `
Connection Metrics:
- Commands sent: ${status.metrics.commands_sent}
- Success rate: ${status.metrics.success_rate.toFixed(1)}%
`;
  }

  if (status.lastOutput.length > 0) {
    output += `
Recent output:
${status.lastOutput.slice(-5).map(line => `  ${line}`).join("\n")}
`;
  }

  return output;
}

// ============================================================================
// run_diagnostics - Test connection quality
// ============================================================================

export const runDiagnosticsSchema = z.object({
  duration_s: z
    .number()
    .min(10)
    .max(120)
    .default(30)
    .describe("Duration to test in seconds (10-120)"),
});

export async function runDiagnostics(
  params: z.infer<typeof runDiagnosticsSchema>
): Promise<string> {
  const manager = getAutonomousDriverManager();

  // Check if driver is already running
  if (manager.isRunning()) {
    return "Cannot run diagnostics while vision driver is running. Stop the driver first.";
  }

  const result = await manager.runDiagnostics({
    duration_s: params.duration_s,
  });

  return `Connection Diagnostics (${params.duration_s}s test):

Commands:
  Total sent:     ${result.commands_sent}
  Success rate:   ${result.success_rate.toFixed(1)}%

Latency (ms):
  Average:        ${result.avg_latency_ms.toFixed(1)}
  P95:            ${result.p95_latency_ms.toFixed(1)}
  Max:            ${result.max_latency_ms.toFixed(1)}

Stability:
  Connection drops: ${result.connection_drops}

${result.recommendation}

${result.success_rate >= 85 ? "Ready for autonomous driving." : "Fix connection issues before driving."}`;
}

// ============================================================================
// Export tool definitions
// ============================================================================

export const autonomyTools = {
  start_vision_driver: {
    name: "start_vision_driver",
    description:
      "Start vision-based autonomous driving. Uses MiDaS depth estimation to navigate and avoid obstacles. Runs independently with a tight 300ms control loop.",
    schema: startVisionDriverSchema,
    handler: startVisionDriver,
  },
  stop_vision_driver: {
    name: "stop_vision_driver",
    description:
      "Stop the vision-based autonomous driver. Sends SIGINT for graceful shutdown with summary output.",
    schema: stopVisionDriverSchema,
    handler: stopVisionDriver,
  },
  driver_status: {
    name: "driver_status",
    description:
      "Get the current status of the vision driver including elapsed time, mode, and connection metrics.",
    schema: driverStatusSchema,
    handler: driverStatus,
  },
  run_diagnostics: {
    name: "run_diagnostics",
    description:
      "Run connection diagnostics to test TCP latency, success rate, and stability. Use this before autonomous driving to verify connection quality.",
    schema: runDiagnosticsSchema,
    handler: runDiagnostics,
  },
};
