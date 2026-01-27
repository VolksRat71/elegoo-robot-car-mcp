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
import json
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, List

import numpy as np

# Import centralized robot client (camera is accessed via HTTP, not direct stream)
from robot_client import RobotClient
import requests
import base64
import io

# Config file path
CONFIG_PATH = Path(__file__).parent / "config.json"

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

def load_config_json() -> dict:
    """Load configuration from JSON file."""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    print(f"[WARN] Config file not found: {CONFIG_PATH}, using defaults")
    return {}


@dataclass
class Config:
    # Mode (for hot-reload)
    _mode: str = "normal"
    _last_reload: float = 0.0

    # Robot connection
    robot_host: str = "192.168.4.1"
    robot_port: int = 100
    camera_url: str = "http://192.168.4.1:81/stream"
    vision_service_url: str = "http://localhost:8765"

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

    # Head swing (servo sweep to find clear path)
    head_swing_enabled: bool = True
    head_swing_angles: List[int] = field(default_factory=lambda: [45, 90, 135])
    head_swing_settle_ms: int = 200
    head_swing_on_stuck: bool = True
    head_swing_on_wall: bool = True

    # Snapshots (periodic captures for Claude to see)
    snapshots_enabled: bool = True
    snapshots_interval_s: float = 5.0
    snapshots_path: str = "drive_snapshots"
    snapshots_max: int = 50

    def hot_reload(self) -> bool:
        """Reload config from JSON if file changed. Returns True if reloaded."""
        try:
            mtime = CONFIG_PATH.stat().st_mtime
            if mtime <= self._last_reload:
                return False

            data = load_config_json()
            modes = data.get("driving_modes", {})
            mode_config = modes.get(self._mode, modes.get("normal", {}))

            # Update tunable values
            self.cruise_speed = mode_config.get("cruise_speed", self.cruise_speed)
            self.slow_speed = mode_config.get("slow_speed", self.slow_speed)
            self.turn_speed = mode_config.get("turn_speed", self.turn_speed)
            self.drive_duration_ms = mode_config.get("drive_duration_ms", self.drive_duration_ms)
            self.turn_degrees_small = mode_config.get("turn_degrees_small", self.turn_degrees_small)
            self.turn_degrees_large = mode_config.get("turn_degrees_large", self.turn_degrees_large)
            self.clear_threshold = mode_config.get("clear_threshold", self.clear_threshold)
            self.obstacle_threshold = mode_config.get("obstacle_threshold", self.obstacle_threshold)
            self.danger_threshold = mode_config.get("danger_threshold", self.danger_threshold)
            self.wall_variance = mode_config.get("wall_variance", self.wall_variance)

            smoothing = data.get("smoothing", {})
            self.ema_alpha = smoothing.get("ema_alpha", self.ema_alpha)

            safety = data.get("safety", {})
            self.max_consecutive_stops = safety.get("max_consecutive_stops", self.max_consecutive_stops)
            self.max_vision_failures = safety.get("max_vision_failures", self.max_vision_failures)

            self._last_reload = mtime
            print(f"[CONFIG] Hot-reloaded: obstacle={self.obstacle_threshold}%, drive={self.drive_duration_ms}ms")
            return True
        except Exception as e:
            print(f"[CONFIG] Hot-reload failed: {e}")
            return False

    @classmethod
    def from_json(cls, mode: str = "normal") -> "Config":
        """Load config from JSON file for specified driving mode."""
        data = load_config_json()

        # Start with defaults
        config = cls()

        # Load connection settings
        conn = data.get("connection", {})
        config.robot_host = conn.get("robot_host", config.robot_host)
        config.robot_port = conn.get("robot_port", config.robot_port)
        config.camera_url = conn.get("camera_url", config.camera_url)
        config.vision_service_url = conn.get("vision_service_url", config.vision_service_url)

        # Load mode-specific settings
        modes = data.get("driving_modes", {})
        mode_config = modes.get(mode, modes.get("normal", {}))

        config.cruise_speed = mode_config.get("cruise_speed", config.cruise_speed)
        config.slow_speed = mode_config.get("slow_speed", config.slow_speed)
        config.turn_speed = mode_config.get("turn_speed", config.turn_speed)
        config.reverse_speed = mode_config.get("reverse_speed", config.reverse_speed)
        config.loop_interval_ms = mode_config.get("loop_interval_ms", config.loop_interval_ms)
        config.drive_duration_ms = mode_config.get("drive_duration_ms", config.drive_duration_ms)
        config.turn_degrees_small = mode_config.get("turn_degrees_small", config.turn_degrees_small)
        config.turn_degrees_large = mode_config.get("turn_degrees_large", config.turn_degrees_large)
        config.reverse_duration_ms = mode_config.get("reverse_duration_ms", config.reverse_duration_ms)
        config.clear_threshold = mode_config.get("clear_threshold", config.clear_threshold)
        config.obstacle_threshold = mode_config.get("obstacle_threshold", config.obstacle_threshold)
        config.danger_threshold = mode_config.get("danger_threshold", config.danger_threshold)
        config.wall_variance = mode_config.get("wall_variance", config.wall_variance)

        # Load smoothing settings
        smoothing = data.get("smoothing", {})
        config.ema_alpha = smoothing.get("ema_alpha", config.ema_alpha)

        # Load safety settings
        safety = data.get("safety", {})
        config.max_consecutive_stops = safety.get("max_consecutive_stops", config.max_consecutive_stops)
        config.max_vision_failures = safety.get("max_vision_failures", config.max_vision_failures)

        # Load head swing settings
        head_swing = data.get("head_swing", {})
        config.head_swing_enabled = head_swing.get("enabled", config.head_swing_enabled)
        config.head_swing_angles = head_swing.get("angles", config.head_swing_angles)
        config.head_swing_settle_ms = head_swing.get("settle_time_ms", config.head_swing_settle_ms)
        config.head_swing_on_stuck = head_swing.get("trigger_on_stuck", config.head_swing_on_stuck)
        config.head_swing_on_wall = head_swing.get("trigger_on_wall", config.head_swing_on_wall)

        # Load snapshot settings
        snapshots = data.get("snapshots", {})
        config.snapshots_enabled = snapshots.get("enabled", config.snapshots_enabled)
        config.snapshots_interval_s = snapshots.get("interval_s", config.snapshots_interval_s)
        config.snapshots_path = snapshots.get("save_path", config.snapshots_path)
        config.snapshots_max = snapshots.get("max_snapshots", config.snapshots_max)

        # Store mode for hot-reload
        config._mode = mode
        config._last_reload = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else 0

        return config


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
    last_snapshot_time: float = 0.0
    snapshot_count: int = 0
    head_swing_count: int = 0


# === Camera Capture ===
# Uses centralized vision service's camera endpoint

def capture_frame(vision_service_url: str) -> Optional[np.ndarray]:
    """Get latest frame from the vision service's camera endpoint."""
    try:
        response = requests.get(f"{vision_service_url}/camera/capture", timeout=2.0)
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


# === Head Swing (Servo Sweep) ===

def head_swing_scan(robot: "RobotClient", config: Config, depth_estimator, vision_service_url: str) -> Optional[int]:
    """
    Sweep servo to find clearest path.
    Returns: best angle (45=left, 90=center, 135=right) or None if failed.
    """
    if not config.head_swing_enabled:
        return None

    print("[HEAD] Scanning for clear path...")
    results = []

    for angle in config.head_swing_angles:
        # Move servo
        robot.look(angle)
        time.sleep(config.head_swing_settle_ms / 1000.0)

        # Capture and analyze depth
        frame = capture_frame(vision_service_url)
        if frame is None:
            continue

        pil_frame = Image.fromarray(frame)
        depth_result = depth_estimator.estimate(pil_frame)
        center_depth = depth_result["depth_zones"]["center"] * 100

        results.append((angle, center_depth))
        print(f"[HEAD] Angle {angle}°: {center_depth:.1f}%")

    # Return servo to center
    robot.look(90)

    if not results:
        return None

    # Find angle with lowest depth (clearest path)
    best_angle, best_depth = min(results, key=lambda x: x[1])
    print(f"[HEAD] Best path: {best_angle}° ({best_depth:.1f}%)")
    return best_angle


# === Snapshot Capture ===

def save_snapshot(frame: np.ndarray, state: DriverState, config: Config, depth: DepthZones, decision: str):
    """Save a snapshot image with metadata for Claude to review."""
    if not config.snapshots_enabled:
        return

    now = time.time()
    if now - state.last_snapshot_time < config.snapshots_interval_s:
        return

    # Create snapshot directory
    snapshot_dir = Path(CONFIG_PATH).parent / config.snapshots_path
    snapshot_dir.mkdir(exist_ok=True)

    # Clean up old snapshots if over limit
    existing = sorted(snapshot_dir.glob("*.jpg"))
    while len(existing) >= config.snapshots_max:
        existing[0].unlink()
        existing = existing[1:]

    # Save snapshot with timestamp and metadata in filename
    timestamp = datetime.now().strftime("%H%M%S")
    elapsed = int(now - state.start_time)
    filename = f"{timestamp}_e{elapsed}s_L{depth.left:.0f}_C{depth.center:.0f}_R{depth.right:.0f}_{decision}.jpg"
    filepath = snapshot_dir / filename

    pil_image = Image.fromarray(frame)
    pil_image.save(filepath, quality=85)

    state.last_snapshot_time = now
    state.snapshot_count += 1
    print(f"[SNAP] Saved {filename}")


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

            # Hot-reload config if file changed (tune without restart!)
            config.hot_reload()

            # Capture frame from vision service
            frame = capture_frame(config.vision_service_url)
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

            # Check if we should do head swing to find better path
            do_head_swing = False
            if not dry_run and robot:
                # Head swing on wall detection
                if config.head_swing_on_wall and is_wall_pattern(state.smoothed_depth, config):
                    do_head_swing = True
                    print("[DRIVER] Wall detected, scanning for path...")

                # Head swing on stuck (consecutive stops)
                if decision == Decision.STOP:
                    state.consecutive_stops += 1
                    if state.consecutive_stops >= config.max_consecutive_stops and config.head_swing_on_stuck:
                        do_head_swing = True
                        print("[DRIVER] Stuck, scanning for path...")
                else:
                    state.consecutive_stops = 0

                # Perform head swing if triggered
                if do_head_swing:
                    best_angle = head_swing_scan(robot, config, depth_estimator, config.vision_service_url)
                    state.head_swing_count += 1
                    state.consecutive_stops = 0

                    if best_angle is not None:
                        # Turn toward clearest direction
                        if best_angle < 90:  # Left is clearer
                            decision = Decision.TURN_LEFT_LARGE
                        elif best_angle > 90:  # Right is clearer
                            decision = Decision.TURN_RIGHT_LARGE
                        else:  # Center is clearest, reverse a bit then go
                            decision = Decision.REVERSE
            else:
                # Handle consecutive stops in dry-run mode
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

                # Note: Reconnection is handled automatically by RobotClient's
                # reconnect-every-3 pattern - no manual reconnect needed here

            # Save periodic snapshot for Claude to see where we are
            save_snapshot(frame, state, config, state.smoothed_depth, decision.value)

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
        print(f"  Head swings:    {state.head_swing_count}")
        print(f"  Snapshots:      {state.snapshot_count}")
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
    parser.add_argument("--mode", choices=["normal", "cautious"], default="normal",
                        help="Driving mode (loads from config.json)")
    parser.add_argument("--cautious", action="store_true", help="Shorthand for --mode cautious")
    parser.add_argument("--dry-run", action="store_true", help="Don't send motor commands")
    parser.add_argument("--robot-host", help="Override robot IP address")
    args = parser.parse_args()

    # Determine mode
    mode = "cautious" if args.cautious else args.mode

    # Load config from JSON
    config = Config.from_json(mode)
    print(f"[CONFIG] Loaded '{mode}' mode from {CONFIG_PATH}")
    print(f"[CONFIG] Speeds: cruise={config.cruise_speed}, slow={config.slow_speed}")
    print(f"[CONFIG] Timing: loop={config.loop_interval_ms}ms, drive={config.drive_duration_ms}ms")
    print(f"[CONFIG] Thresholds: clear={config.clear_threshold}%, obstacle={config.obstacle_threshold}%, danger={config.danger_threshold}%")

    # Allow override of robot host
    if args.robot_host:
        config.robot_host = args.robot_host

    run_driver(args.duration, config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
