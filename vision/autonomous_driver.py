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
import threading
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
    """Direct TCP communication with Elegoo robot.

    ESP32 firmware limitation: Can only handle ~4-5 messages per connection
    before it drops. We proactively reconnect every 3 commands to stay reliable.
    """

    # ESP32 can handle ~4-5 commands per connection, reconnect at 3 to be safe
    COMMANDS_PER_CONNECTION = 3

    def __init__(self, host: str, port: int, metrics: Optional[ConnectionMetrics] = None):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.metrics = metrics
        self.reconnect_attempts = 0
        self.commands_since_connect = 0

    def connect(self) -> bool:
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(2.0)
            # Enable TCP_NODELAY for lower latency
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.socket.connect((self.host, self.port))
            print(f"[ROBOT] Connected to {self.host}:{self.port}")
            self.reconnect_attempts = 0
            self.commands_since_connect = 0
            return True
        except Exception as e:
            print(f"[ROBOT] Connection failed: {e}")
            return False

    def reconnect(self) -> bool:
        """Attempt to reconnect after connection loss."""
        self.disconnect()
        self.reconnect_attempts += 1
        return self.connect()

    def _ensure_fresh_connection(self) -> bool:
        """Reconnect if we've sent too many commands on this connection."""
        if self.commands_since_connect >= self.COMMANDS_PER_CONNECTION:
            self.disconnect()
            return self.connect()
        return self.socket is not None

    def disconnect(self):
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.commands_since_connect = 0

    def send_command(self, cmd: int, d1: int = 0, d2: int = 0, d3: int = 0) -> tuple[bool, float]:
        """Send command and return (success, latency_ms).

        Uses fire-and-forget mode - ESP32 doesn't reliably ACK commands,
        but they still get through. We only wait briefly to clear buffer.
        """
        # Proactively reconnect to avoid ESP32 connection limit
        if not self._ensure_fresh_connection():
            if self.metrics:
                self.metrics.record(False, 0)
            return False, 0

        start = time.perf_counter()
        try:
            msg = json.dumps({"H": "1", "N": cmd, "D1": d1, "D2": d2, "D3": d3}) + "\n"
            self.socket.sendall(msg.encode())
            self.commands_since_connect += 1

            # Brief non-blocking read to clear any buffered data
            # Don't wait for ACK - ESP32 doesn't reliably send them
            self.socket.settimeout(0.05)
            try:
                self.socket.recv(1024)
            except socket.timeout:
                pass

            latency_ms = (time.perf_counter() - start) * 1000
            if self.metrics:
                self.metrics.record(True, latency_ms)
            return True, latency_ms

        except Exception as e:
            latency_ms = (time.perf_counter() - start) * 1000
            print(f"[ROBOT] Command failed: {e}")
            if self.metrics:
                self.metrics.record(False, latency_ms)
            # Force reconnect on next command
            self.disconnect()
            return False, latency_ms

    def drive(self, direction: str, speed: int, duration_ms: int) -> bool:
        """Drive in a direction using MOTOR_CONTROL (N=1)."""
        # Map speed 0-100 to 0-250
        mapped_speed = int(speed * 2.5)

        # Motor direction: 0=stop, 1=forward, 2=backward
        MOTOR_STOP = 0
        MOTOR_FWD = 1
        MOTOR_BWD = 2

        if direction == "forward":
            # Both motors forward
            self.send_command(1, 0, mapped_speed, MOTOR_FWD)
        elif direction == "backward":
            # Both motors backward
            self.send_command(1, 0, mapped_speed, MOTOR_BWD)
        elif direction == "left":
            # Right motor forward, left motor backward (turn left while moving)
            self.send_command(1, 1, mapped_speed, MOTOR_FWD)  # Right forward
            self.send_command(1, 2, mapped_speed, MOTOR_BWD)  # Left backward
        elif direction == "right":
            # Left motor forward, right motor backward (turn right while moving)
            self.send_command(1, 2, mapped_speed, MOTOR_FWD)  # Left forward
            self.send_command(1, 1, mapped_speed, MOTOR_BWD)  # Right backward
        else:
            return self.stop()

        if duration_ms > 0:
            time.sleep(duration_ms / 1000.0)
            self.stop()
        return True

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
        success, _ = self.send_command(1, 0, 0, 0)  # Motor stop
        return success


# === Camera Capture ===

class CameraStream:
    """Persistent MJPEG stream reader with frame caching.

    Keeps the camera stream open and continuously reads frames in background.
    Control loop can grab the latest frame instantly without HTTP overhead.
    """

    def __init__(self, url: str):
        self.url = url
        self.latest_frame: Optional[np.ndarray] = None
        self.frame_time: float = 0
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()
        self.error_count = 0
        self.frame_count = 0

    def start(self) -> bool:
        """Start the background stream reader."""
        if self.running:
            return True

        self.running = True
        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()

        # Wait up to 3 seconds for first frame
        for _ in range(30):
            if self.latest_frame is not None:
                print(f"[CAMERA] Stream started, first frame received")
                return True
            time.sleep(0.1)

        print(f"[CAMERA] Warning: No frame received in 3s, continuing anyway")
        return True

    def stop(self):
        """Stop the background stream reader."""
        self.running = False
        if self.thread:
            self.thread.join(timeout=2.0)
            self.thread = None

    def get_frame(self) -> Optional[np.ndarray]:
        """Get the latest cached frame (instant, no HTTP call)."""
        with self.lock:
            return self.latest_frame.copy() if self.latest_frame is not None else None

    def get_frame_age_ms(self) -> float:
        """How old is the cached frame in milliseconds."""
        if self.frame_time == 0:
            return float('inf')
        return (time.time() - self.frame_time) * 1000

    def _stream_loop(self):
        """Background loop that reads frames from MJPEG stream."""
        while self.running:
            try:
                # Open persistent connection to MJPEG stream
                response = requests.get(self.url, timeout=5.0, stream=True)
                if response.status_code != 200:
                    print(f"[CAMERA] Stream returned {response.status_code}")
                    time.sleep(1.0)
                    continue

                bytes_data = b''
                for chunk in response.iter_content(chunk_size=4096):
                    if not self.running:
                        break

                    bytes_data += chunk

                    # Look for complete JPEG frame
                    while True:
                        start = bytes_data.find(b'\xff\xd8')
                        end = bytes_data.find(b'\xff\xd9')

                        if start != -1 and end != -1 and end > start:
                            # Extract JPEG frame
                            jpg_data = bytes_data[start:end+2]
                            bytes_data = bytes_data[end+2:]

                            try:
                                img = Image.open(BytesIO(jpg_data))
                                frame = np.array(img)

                                with self.lock:
                                    self.latest_frame = frame
                                    self.frame_time = time.time()
                                    self.frame_count += 1

                                self.error_count = 0
                            except Exception as e:
                                print(f"[CAMERA] Frame decode error: {e}")
                        else:
                            break

                    # Prevent buffer from growing too large
                    if len(bytes_data) > 200000:
                        bytes_data = bytes_data[-50000:]

            except Exception as e:
                self.error_count += 1
                if self.error_count <= 3:
                    print(f"[CAMERA] Stream error: {e}")
                time.sleep(0.5)

        print(f"[CAMERA] Stream stopped after {self.frame_count} frames")


# Global camera stream instance
_camera_stream: Optional[CameraStream] = None

def get_camera_stream(url: str) -> CameraStream:
    """Get or create the global camera stream."""
    global _camera_stream
    if _camera_stream is None:
        _camera_stream = CameraStream(url)
    return _camera_stream

def capture_frame(camera_url: str) -> Optional[np.ndarray]:
    """Get latest frame from the persistent camera stream."""
    stream = get_camera_stream(camera_url)
    if not stream.running:
        stream.start()
    return stream.get_frame()


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

    state = DriverState(
        start_time=time.time(),
        smoothed_depth=DepthZones(left=25, center=14, right=25),  # baseline
    )

    robot: Optional[RobotClient] = None
    if not dry_run:
        robot = RobotClient(config.robot_host, config.robot_port, metrics=state.connection_metrics)
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

                # Show latency info if available
                metrics = state.connection_metrics
                latency_info = ""
                if metrics.latencies_ms:
                    latency_info = f" [{metrics.latencies_ms[-1]:.0f}ms]"

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

        # Stop camera stream
        global _camera_stream
        if _camera_stream:
            _camera_stream.stop()
            _camera_stream = None

        elapsed = time.time() - state.start_time
        metrics = state.connection_metrics

        print(f"\n{'='*60}")
        print(f"DRIVER SUMMARY")
        print(f"{'='*60}")
        print(f"\nDriving:")
        print(f"  Duration:       {elapsed:.1f}s")
        print(f"  Forward moves:  {state.forward_count}")
        print(f"  Turns:          {state.turn_count}")
        print(f"  Vision fails:   {state.vision_failures}")

        if not dry_run and metrics.commands_sent > 0:
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
        print("[CONFIG] Using cautious settings")

    run_driver(args.duration, config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
