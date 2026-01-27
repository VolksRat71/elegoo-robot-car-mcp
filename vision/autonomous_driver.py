#!/usr/bin/env python3
"""
Autonomous vision-based driver for Elegoo robot car.
Runs locally with tight control loop - bypasses Claude latency.

Usage:
    python autonomous_driver.py [--duration 30] [--cautious] [--dry-run]

Calibrated thresholds from sample collection (2026-01-27):
- Clear baseline: ~14% center, ~24-25% L/R
- Obstacle at 1ft: ~42% in affected zone
- Very close (<6in): ~70% center
- Wall (uniform): ~44-46% all zones
"""

import argparse
import signal
import sys
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import numpy as np

# Import centralized robot client (camera is accessed via HTTP, not direct stream)
from robot_client import RobotClient
import requests
import base64
import io

# Try to import vision models
try:
    from models.depth import DepthEstimator
    VISION_AVAILABLE = True
except ImportError:
    VISION_AVAILABLE = False
    print("[WARN] Vision models not available, run from vision/ directory")

# Try to import camera capture
try:
    from PIL import Image
    CAMERA_AVAILABLE = True
except ImportError:
    CAMERA_AVAILABLE = False


# === Configuration ===

@dataclass
class Config:
    # Robot connection
    robot_host: str = "192.168.4.1"
    robot_port: int = 100
    camera_url: str = "http://192.168.4.1:81/stream"

    # Thresholds (percentages)
    clear_threshold: float = 25.0
    obstacle_threshold: float = 40.0
    danger_threshold: float = 60.0
    wall_variance: float = 10.0

    # Speeds (0-100)
    cruise_speed: int = 35
    slow_speed: int = 25
    turn_speed: int = 40
    reverse_speed: int = 30

    # Timing
    # drive_duration > loop_interval = overlapping commands = smooth motion
    # If connection drops, robot stops after drive_duration (failsafe)
    loop_interval_ms: int = 300
    drive_duration_ms: int = 500  # 200ms overlap for smooth motion
    turn_degrees_small: int = 25
    turn_degrees_large: int = 50
    reverse_duration_ms: int = 300

    # Smoothing
    ema_alpha: float = 0.4

    # Safety
    max_consecutive_stops: int = 3
    max_vision_failures: int = 5


class Decision(Enum):
    FORWARD = "forward"
    FORWARD_SLOW = "forward_slow"
    TURN_LEFT = "turn_left"
    TURN_RIGHT = "turn_right"
    TURN_LEFT_LARGE = "turn_left_large"
    TURN_RIGHT_LARGE = "turn_right_large"
    REVERSE = "reverse"
    STOP = "stop"


@dataclass
class DepthZones:
    left: float
    center: float
    right: float


@dataclass
class DriverState:
    running: bool = True
    last_decision: Decision = Decision.STOP
    consecutive_stops: int = 0
    vision_failures: int = 0
    smoothed_depth: Optional[DepthZones] = None
    turn_count: int = 0
    forward_count: int = 0
    start_time: float = 0.0


# === Camera Capture ===
# Uses centralized vision service's camera endpoint

VISION_SERVICE_URL = "http://localhost:8765"

def capture_frame(camera_url: str) -> Optional[np.ndarray]:
    """Get latest frame from the vision service's camera endpoint."""
    try:
        response = requests.get(f"{VISION_SERVICE_URL}/camera/capture", timeout=2.0)
        if response.status_code == 200:
            data = response.json()
            if data.get("success") and data.get("image_base64"):
                # Decode base64 image to numpy array
                image_bytes = base64.b64decode(data["image_base64"])
                pil_image = Image.open(io.BytesIO(image_bytes))
                return np.array(pil_image)
        return None
    except Exception as e:
        print(f"[CAMERA] Error fetching from vision service: {e}")
        return None


# === Decision Engine ===

def smooth_depth(current: DepthZones, previous: Optional[DepthZones], alpha: float) -> DepthZones:
    """Apply exponential moving average smoothing."""
    if previous is None:
        return current
    return DepthZones(
        left=alpha * current.left + (1 - alpha) * previous.left,
        center=alpha * current.center + (1 - alpha) * previous.center,
        right=alpha * current.right + (1 - alpha) * previous.right,
    )


def is_wall_pattern(depth: DepthZones, config: Config) -> bool:
    """Check if depth pattern indicates a wall."""
    values = [depth.left, depth.center, depth.right]
    return max(values) - min(values) < config.wall_variance and min(values) > config.obstacle_threshold


def is_narrow_passage(depth: DepthZones, config: Config) -> bool:
    """Check if depth pattern indicates a narrow passage."""
    return (
        depth.left > config.obstacle_threshold and
        depth.right > config.obstacle_threshold and
        depth.center < config.clear_threshold
    )


def make_decision(depth: DepthZones, state: DriverState, config: Config) -> Decision:
    """Make navigation decision based on depth zones."""
    left, center, right = depth.left, depth.center, depth.right

    # DANGER: Very close obstacle
    if center > config.danger_threshold:
        return Decision.STOP

    # Wall detected - turn around
    if is_wall_pattern(depth, config):
        return Decision.TURN_RIGHT_LARGE if state.turn_count % 2 == 0 else Decision.TURN_LEFT_LARGE

    # Narrow passage - proceed slowly
    if is_narrow_passage(depth, config):
        return Decision.FORWARD_SLOW

    # Center blocked - turn toward clearer side
    if center > config.obstacle_threshold:
        if left < right:
            return Decision.TURN_LEFT if left < config.obstacle_threshold else Decision.TURN_LEFT_LARGE
        else:
            return Decision.TURN_RIGHT if right < config.obstacle_threshold else Decision.TURN_RIGHT_LARGE

    # Left blocked
    if left > config.obstacle_threshold and right < config.obstacle_threshold:
        return Decision.TURN_RIGHT

    # Right blocked
    if right > config.obstacle_threshold and left < config.obstacle_threshold:
        return Decision.TURN_LEFT

    # Some obstruction but center clear
    if left > config.clear_threshold or right > config.clear_threshold:
        return Decision.FORWARD_SLOW

    # All clear
    return Decision.FORWARD


def execute_decision(decision: Decision, robot: RobotClient, config: Config) -> bool:
    """Execute a navigation decision."""
    result = None
    if decision == Decision.FORWARD:
        result = robot.drive("forward", config.cruise_speed, config.drive_duration_ms)
    elif decision == Decision.FORWARD_SLOW:
        result = robot.drive("forward", config.slow_speed, config.drive_duration_ms)
    elif decision == Decision.TURN_LEFT:
        result = robot.turn(-config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_RIGHT:
        result = robot.turn(config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_LEFT_LARGE:
        result = robot.turn(-config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.TURN_RIGHT_LARGE:
        result = robot.turn(config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.REVERSE:
        result = robot.drive("backward", config.reverse_speed, config.reverse_duration_ms)
    else:
        result = robot.stop()

    # Centralized RobotClient returns dict with 'success' key
    return result.get("success", False) if isinstance(result, dict) else bool(result)


# === Main Driver Loop ===

def run_driver(duration_s: int, config: Config, dry_run: bool = False):
    """Main autonomous driving loop."""

    if not VISION_AVAILABLE:
        print("[ERROR] Vision models not available")
        return

    # Initialize
    print("[DRIVER] Initializing...")
    depth_estimator = DepthEstimator()

    state = DriverState(
        start_time=time.time(),
        smoothed_depth=DepthZones(left=25, center=14, right=25),  # baseline
    )

    robot: Optional[RobotClient] = None
    if not dry_run:
        robot = RobotClient(config.robot_host, config.robot_port)
        if not robot.connect():
            print("[ERROR] Could not connect to robot")
            return

    # Signal handler for clean shutdown
    def signal_handler(sig, frame):
        print("\n[DRIVER] Interrupted, stopping...")
        state.running = False

    signal.signal(signal.SIGINT, signal_handler)

    end_time = time.time() + duration_s
    print(f"[DRIVER] Starting for {duration_s}s...")

    try:
        while state.running and time.time() < end_time:
            loop_start = time.time()

            # Capture frame
            frame = capture_frame(config.camera_url)
            if frame is None:
                state.vision_failures += 1
                if state.vision_failures > config.max_vision_failures:
                    print("[DRIVER] Too many vision failures, stopping")
                    break
                time.sleep(config.loop_interval_ms / 1000.0)
                continue

            state.vision_failures = 0

            # Get depth - convert numpy array to PIL Image
            pil_frame = Image.fromarray(frame)
            depth_result = depth_estimator.estimate(pil_frame)
            zones = depth_result["depth_zones"]
            current_depth = DepthZones(
                left=zones["left"] * 100,
                center=zones["center"] * 100,
                right=zones["right"] * 100,
            )

            # Smooth
            state.smoothed_depth = smooth_depth(current_depth, state.smoothed_depth, config.ema_alpha)

            # Decide
            decision = make_decision(state.smoothed_depth, state, config)

            # Handle consecutive stops
            if decision == Decision.STOP:
                state.consecutive_stops += 1
                if state.consecutive_stops > config.max_consecutive_stops:
                    print("[DRIVER] Multiple stops, reversing...")
                    decision = Decision.REVERSE
                    state.consecutive_stops = 0
            else:
                state.consecutive_stops = 0

            # Track stats
            if decision in (Decision.FORWARD, Decision.FORWARD_SLOW):
                state.forward_count += 1
            if decision.name.startswith("TURN"):
                state.turn_count += 1

            # Execute
            if dry_run:
                print(f"[DRY-RUN] L:{state.smoothed_depth.left:5.1f}% "
                      f"C:{state.smoothed_depth.center:5.1f}% "
                      f"R:{state.smoothed_depth.right:5.1f}% → {decision.value}")
            else:
                success = execute_decision(decision, robot, config)
                status = "OK" if success else "FAIL"

                # Show latency info if available from centralized robot client
                latency_info = ""
                if robot and robot.metrics.latencies_ms:
                    latency_info = f" [{robot.metrics.latencies_ms[-1]:.0f}ms]"

                print(f"[DRIVER] L:{state.smoothed_depth.left:5.1f}% "
                      f"C:{state.smoothed_depth.center:5.1f}% "
                      f"R:{state.smoothed_depth.right:5.1f}% → {decision.value} "
                      f"({status}){latency_info}")

                # Attempt reconnection on repeated failures
                if not success and robot.reconnect_attempts < 3:
                    print("[DRIVER] Command failed, attempting reconnect...")
                    if robot.reconnect():
                        print("[DRIVER] Reconnected successfully")
                    else:
                        print("[DRIVER] Reconnect failed")

            state.last_decision = decision

            # Maintain loop timing
            elapsed = time.time() - loop_start
            sleep_time = (config.loop_interval_ms / 1000.0) - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    finally:
        # Cleanup
        if robot:
            robot.stop()
            robot.disconnect()

        # Camera cleanup not needed - vision service manages the stream

        elapsed = time.time() - state.start_time

        print(f"\n{'='*60}")
        print(f"DRIVER SUMMARY")
        print(f"{'='*60}")
        print(f"\nDriving:")
        print(f"  Duration:       {elapsed:.1f}s")
        print(f"  Forward moves:  {state.forward_count}")
        print(f"  Turns:          {state.turn_count}")
        print(f"  Vision fails:   {state.vision_failures}")

        if not dry_run and robot and robot.metrics.commands_sent > 0:
            metrics = robot.metrics
            print(f"\nConnection Quality:")
            print(f"  Commands sent:  {metrics.commands_sent}")
            print(f"  Success rate:   {metrics.success_rate():.1f}%")
            print(f"  Avg latency:    {metrics.avg_latency():.1f}ms")
            print(f"  Max latency:    {metrics.max_latency():.1f}ms")

            if metrics.success_rate() < 90:
                print(f"\n⚠️  Poor connection - {metrics.commands_failed} commands failed")
            elif metrics.avg_latency() > 100:
                print(f"\n⚠️  High latency may affect responsiveness")
            else:
                print(f"\n✅ Connection quality acceptable")

        print(f"{'='*60}")


# === Entry Point ===

def main():
    parser = argparse.ArgumentParser(description="Autonomous vision-based robot driver")
    parser.add_argument("--duration", type=int, default=30, help="Duration in seconds")
    parser.add_argument("--cautious", action="store_true", help="Use extra cautious settings")
    parser.add_argument("--dry-run", action="store_true", help="Don't send motor commands")
    parser.add_argument("--robot-host", default="192.168.4.1", help="Robot IP address")
    args = parser.parse_args()

    config = Config(robot_host=args.robot_host)

    if args.cautious:
        config.cruise_speed = 25
        config.slow_speed = 18
        config.clear_threshold = 30
        config.obstacle_threshold = 35
        config.drive_duration_ms = 600  # Even more overlap for smoother cautious driving
        print("[CONFIG] Using cautious settings")

    run_driver(args.duration, config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
