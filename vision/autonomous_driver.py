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
import signal
import socket
import sys
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import numpy as np

# Try to import vision models
try:
    from models.depth import DepthEstimator
    VISION_AVAILABLE = True
except ImportError:
    VISION_AVAILABLE = False
    print("[WARN] Vision models not available, run from vision/ directory")

# Try to import camera capture
try:
    import requests
    from PIL import Image
    from io import BytesIO
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
    loop_interval_ms: int = 300
    drive_duration_ms: int = 300
    turn_degrees_small: int = 25
    turn_degrees_large: int = 50
    reverse_duration_ms: int = 250

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
class ConnectionMetrics:
    """Track connection quality during driving."""
    commands_sent: int = 0
    commands_success: int = 0
    commands_failed: int = 0
    latencies_ms: list = None

    def __post_init__(self):
        if self.latencies_ms is None:
            self.latencies_ms = []

    def record(self, success: bool, latency_ms: float):
        self.commands_sent += 1
        if success:
            self.commands_success += 1
            self.latencies_ms.append(latency_ms)
        else:
            self.commands_failed += 1

    def success_rate(self) -> float:
        if self.commands_sent == 0:
            return 100.0
        return (self.commands_success / self.commands_sent) * 100

    def avg_latency(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return sum(self.latencies_ms) / len(self.latencies_ms)

    def max_latency(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return max(self.latencies_ms)


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
    connection_metrics: ConnectionMetrics = None

    def __post_init__(self):
        if self.connection_metrics is None:
            self.connection_metrics = ConnectionMetrics()


# === Robot Communication ===

class RobotClient:
    """Direct TCP communication with Elegoo robot."""

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None

    def connect(self) -> bool:
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(2.0)
            self.socket.connect((self.host, self.port))
            print(f"[ROBOT] Connected to {self.host}:{self.port}")
            return True
        except Exception as e:
            print(f"[ROBOT] Connection failed: {e}")
            return False

    def disconnect(self):
        if self.socket:
            self.socket.close()
            self.socket = None

    def send_command(self, cmd: int, d1: int = 0, d2: int = 0, d3: int = 0) -> bool:
        if not self.socket:
            return False
        try:
            msg = json.dumps({"H": "1", "N": cmd, "D1": d1, "D2": d2, "D3": d3}) + "\n"
            self.socket.sendall(msg.encode())
            # Read response (non-blocking, just clear buffer)
            self.socket.settimeout(0.1)
            try:
                self.socket.recv(1024)
            except socket.timeout:
                pass
            self.socket.settimeout(2.0)
            return True
        except Exception as e:
            print(f"[ROBOT] Command failed: {e}")
            return False

    def drive(self, direction: str, speed: int, duration_ms: int) -> bool:
        """Drive in a direction."""
        # Map speed 0-100 to 0-250
        mapped_speed = int(speed * 2.5)

        # Direction mapping for CMD.CAR_DIRECTION (N=3)
        dir_map = {"forward": 1, "backward": 2, "left": 3, "right": 4, "stop": 0}
        dir_code = dir_map.get(direction, 0)

        if dir_code == 0:
            return self.stop()

        # Send drive command
        success = self.send_command(3, dir_code, mapped_speed, 0)
        if success and duration_ms > 0:
            time.sleep(duration_ms / 1000.0)
            self.stop()
        return success

    def turn(self, degrees: int, speed: int) -> bool:
        """Turn in place using differential drive."""
        mapped_speed = int(speed * 2.5)
        duration_ms = abs(degrees) * 10  # ~10ms per degree

        # Use motor control for in-place turning
        # Motor 1 = right, Motor 2 = left
        # Direction: 1 = forward, 2 = backward

        if degrees > 0:
            # Turn right: left forward, right backward
            self.send_command(1, 2, mapped_speed, 1)  # Left forward
            self.send_command(1, 1, mapped_speed, 2)  # Right backward
        else:
            # Turn left: right forward, left backward
            self.send_command(1, 1, mapped_speed, 1)  # Right forward
            self.send_command(1, 2, mapped_speed, 2)  # Left backward

        time.sleep(duration_ms / 1000.0)
        return self.stop()

    def stop(self) -> bool:
        """Emergency stop."""
        return self.send_command(1, 0, 0, 0)  # Motor stop


# === Camera Capture ===

def capture_frame(camera_url: str) -> Optional[np.ndarray]:
    """Capture a single frame from the ESP32 camera stream."""
    try:
        # For MJPEG stream, grab one frame
        response = requests.get(camera_url, timeout=1.0, stream=True)
        if response.status_code == 200:
            # Read JPEG boundary
            bytes_data = b''
            for chunk in response.iter_content(chunk_size=1024):
                bytes_data += chunk
                # Look for JPEG end marker
                end = bytes_data.find(b'\xff\xd9')
                if end != -1:
                    # Find start marker
                    start = bytes_data.find(b'\xff\xd8')
                    if start != -1:
                        jpg_data = bytes_data[start:end+2]
                        img = Image.open(BytesIO(jpg_data))
                        return np.array(img)
                if len(bytes_data) > 100000:  # Safety limit
                    break
        return None
    except Exception as e:
        print(f"[CAMERA] Capture failed: {e}")
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
    if decision == Decision.FORWARD:
        return robot.drive("forward", config.cruise_speed, config.drive_duration_ms)
    elif decision == Decision.FORWARD_SLOW:
        return robot.drive("forward", config.slow_speed, config.drive_duration_ms)
    elif decision == Decision.TURN_LEFT:
        return robot.turn(-config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_RIGHT:
        return robot.turn(config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_LEFT_LARGE:
        return robot.turn(-config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.TURN_RIGHT_LARGE:
        return robot.turn(config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.REVERSE:
        return robot.drive("backward", config.reverse_speed, config.reverse_duration_ms)
    else:
        return robot.stop()


# === Main Driver Loop ===

def run_driver(duration_s: int, config: Config, dry_run: bool = False):
    """Main autonomous driving loop."""

    if not VISION_AVAILABLE:
        print("[ERROR] Vision models not available")
        return

    # Initialize
    print("[DRIVER] Initializing...")
    depth_estimator = DepthEstimator()

    robot: Optional[RobotClient] = None
    if not dry_run:
        robot = RobotClient(config.robot_host, config.robot_port)
        if not robot.connect():
            print("[ERROR] Could not connect to robot")
            return

    state = DriverState(
        start_time=time.time(),
        smoothed_depth=DepthZones(left=25, center=14, right=25),  # baseline
    )

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

            # Get depth
            depth_map, zones = depth_estimator.estimate(frame)
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
                print(f"[DRIVER] L:{state.smoothed_depth.left:5.1f}% "
                      f"C:{state.smoothed_depth.center:5.1f}% "
                      f"R:{state.smoothed_depth.right:5.1f}% → {decision.value} "
                      f"({'OK' if success else 'FAIL'})")

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

        elapsed = time.time() - state.start_time
        print(f"\n[DRIVER] Summary:")
        print(f"  Duration: {elapsed:.1f}s")
        print(f"  Forward moves: {state.forward_count}")
        print(f"  Turns: {state.turn_count}")
        print(f"  Vision failures: {state.vision_failures}")


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
        print("[CONFIG] Using cautious settings")

    run_driver(args.duration, config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
