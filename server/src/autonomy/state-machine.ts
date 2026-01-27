/**
 * Autonomy State Machine
 *
 * Tracks the robot's high-level operational state.
 * Pre-laser version: Only IDLE <-> EXECUTING <-> STUCK transitions.
 * Post-laser: Will add AVOIDING -> RECOVERING -> RELOCALIZING.
 */

import type { AutonomyState } from "./world-state.js";

export type AutonomyEvent =
  | { type: "GOAL_RECEIVED" }
  | { type: "GOAL_REACHED" }
  | { type: "OBSTACLE_DETECTED" }
  | { type: "RECOVERY_SUCCESS" }
  | { type: "RECOVERY_FAILED" }
  | { type: "MANUAL_STOP" }
  | { type: "RESET" };

export class AutonomyStateMachine {
  private state: AutonomyState = "IDLE";
  private stuckCounter: number = 0;
  private lastAction: string = "";
  private obstacleCount: number = 0;

  /**
   * Transition to a new state based on an event
   */
  transition(event: AutonomyEvent): void {
    const previousState = this.state;

    switch (this.state) {
      case "IDLE":
        if (event.type === "GOAL_RECEIVED") {
          this.state = "EXECUTING";
          this.stuckCounter = 0;
          this.obstacleCount = 0;
        }
        break;

      case "EXECUTING":
        if (event.type === "GOAL_REACHED") {
          this.state = "IDLE";
          this.stuckCounter = 0;
        } else if (event.type === "OBSTACLE_DETECTED") {
          this.obstacleCount++;
          // Pre-laser: After 3 obstacles in a row, consider stuck
          if (this.obstacleCount >= 3) {
            this.state = "STUCK";
            this.stuckCounter++;
          }
          // Post-laser: Would transition to AVOIDING here
        } else if (event.type === "MANUAL_STOP") {
          this.state = "IDLE";
        }
        break;

      case "AVOIDING":
        // Post-laser implementation
        if (event.type === "RECOVERY_SUCCESS") {
          this.state = "EXECUTING";
          this.obstacleCount = 0;
        } else if (event.type === "RECOVERY_FAILED") {
          this.state = "RECOVERING";
        } else if (event.type === "MANUAL_STOP") {
          this.state = "IDLE";
        }
        break;

      case "RECOVERING":
        // Post-laser implementation
        if (event.type === "RECOVERY_SUCCESS") {
          this.state = "EXECUTING";
          this.obstacleCount = 0;
        } else if (event.type === "RECOVERY_FAILED") {
          this.state = "RELOCALIZING";
        } else if (event.type === "MANUAL_STOP") {
          this.state = "IDLE";
        }
        break;

      case "RELOCALIZING":
        // Post-laser implementation
        if (event.type === "RECOVERY_SUCCESS") {
          this.state = "EXECUTING";
        } else if (event.type === "RECOVERY_FAILED") {
          this.state = "STUCK";
          this.stuckCounter++;
        } else if (event.type === "MANUAL_STOP") {
          this.state = "IDLE";
        }
        break;

      case "STUCK":
        if (event.type === "GOAL_RECEIVED") {
          this.state = "EXECUTING";
          this.obstacleCount = 0;
        } else if (event.type === "MANUAL_STOP" || event.type === "RESET") {
          this.state = "IDLE";
          this.stuckCounter = 0;
          this.obstacleCount = 0;
        }
        break;
    }

    if (previousState !== this.state) {
      console.error(`[StateMachine] ${previousState} -> ${this.state} (event: ${event.type})`);
    }
  }

  /**
   * Reset obstacle counter (called when movement succeeds)
   */
  clearObstacles(): void {
    this.obstacleCount = 0;
  }

  /**
   * Get current state
   */
  getState(): AutonomyState {
    return this.state;
  }

  /**
   * Get stuck counter
   */
  getStuckCounter(): number {
    return this.stuckCounter;
  }

  /**
   * Get obstacle count for current execution
   */
  getObstacleCount(): number {
    return this.obstacleCount;
  }

  /**
   * Set last action description
   */
  setLastAction(action: string): void {
    this.lastAction = action;
  }

  /**
   * Get last action description
   */
  getLastAction(): string {
    return this.lastAction;
  }

  /**
   * Check if currently executing a goal
   */
  isExecuting(): boolean {
    return this.state === "EXECUTING" || this.state === "AVOIDING" || this.state === "RECOVERING";
  }

  /**
   * Check if in a terminal/blocked state
   */
  isBlocked(): boolean {
    return this.state === "STUCK";
  }

  /**
   * Force state (for manual intervention)
   */
  forceState(state: AutonomyState): void {
    console.error(`[StateMachine] Force state: ${this.state} -> ${state}`);
    this.state = state;
    if (state === "IDLE") {
      this.obstacleCount = 0;
    }
  }
}

// Singleton instance
let stateMachineInstance: AutonomyStateMachine | null = null;

export function getAutonomyStateMachine(): AutonomyStateMachine {
  if (!stateMachineInstance) {
    stateMachineInstance = new AutonomyStateMachine();
  }
  return stateMachineInstance;
}
