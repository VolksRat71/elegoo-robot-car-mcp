"""
Centralized Robot Client for Elegoo Robot Car.

All robot communication goes through this single module.
Handles TCP connection management with reconnect-every-3 pattern
to work around ESP32 firmware limitations.
"""

import json
import socket
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import requests


# === Config Loading ===

CONFIG_PATH = Path(__file__).parent / "config.json"

def load_config() -> dict:
    """Load configuration from JSON file."""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


# === Connection Metrics ===

@dataclass
class ConnectionMetrics:
    """Track connection quality metrics."""
    commands_sent: int = 0
    commands_success: int = 0
    commands_failed: int = 0
    latencies_ms: list = field(default_factory=list)
    connection_drops: int = 0
    reconnections: int = 0

    def record(self, success: bool, latency_ms: float):
        self.commands_sent += 1
        if success:
            self.commands_success += 1
            self.latencies_ms.append(latency_ms)
        else:
            self.commands_failed += 1

    def success_rate(self) -> float:
        if self.commands_sent == 0:
            return 0.0
        return (self.commands_success / self.commands_sent) * 100

    def avg_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return sum(self.latencies_ms) / len(self.latencies_ms)

    # Aliases for compatibility with autonomous_driver
    def avg_latency(self) -> float:
        return self.avg_latency_ms()

    def max_latency(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return max(self.latencies_ms)

    def to_dict(self) -> dict:
        return {
            "commands_sent": self.commands_sent,
            "commands_success": self.commands_success,
            "commands_failed": self.commands_failed,
            "success_rate": round(self.success_rate(), 1),
            "avg_latency_ms": round(self.avg_latency_ms(), 1),
            "connection_drops": self.connection_drops,
            "reconnections": self.reconnections,
        }


# === Robot TCP Client ===

class RobotClient:
    """Direct TCP communication with Elegoo robot.

    ESP32 firmware limitation: Can only handle ~4-5 messages per connection
    before it drops. We proactively reconnect every 3 commands to stay reliable.

    This is the SINGLE point of communication with the robot.
    All commands must go through this class.
    """

    # ESP32 can handle ~4-5 commands per connection, reconnect at 3 to be safe
    COMMANDS_PER_CONNECTION = 3

    # Command constants
    CMD_MOTOR_CONTROL = 1   # N=1: D1=motor(0=all,1=R,2=L), D2=speed, D3=dir
    CMD_CAR_DIRECTION = 3   # N=3: D1=direction, D2=speed
    CMD_SERVO = 5           # N=5: D1=servo(1=pan), D2=angle(0-180)
    CMD_LED = 8             # N=8: D1=led(0=all), D2=R, D3=G, D4=B
    CMD_ULTRASONIC = 21     # N=21: D1=1
    CMD_LINE_TRACKING = 22  # N=22: D1=1
    CMD_GROUND_CHECK = 23   # N=23: ping/status
    CMD_STANDBY = 100       # N=100: stop all

    # Motor direction values (for CMD_MOTOR_CONTROL)
    MOTOR_STOP = 0
    MOTOR_FORWARD = 1
    MOTOR_BACKWARD = 2

    # Car direction values (for CMD_CAR_DIRECTION)
    CAR_FORWARD = 0
    CAR_BACKWARD = 1
    CAR_LEFT = 2
    CAR_RIGHT = 3
    CAR_STOP = 8

    _instance: Optional["RobotClient"] = None
    _lock = threading.Lock()

    def __init__(self, host: str = "192.168.4.1", port: int = 100):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.metrics = ConnectionMetrics()
        self.commands_since_connect = 0
        self._command_lock = threading.Lock()

    @classmethod
    def get_instance(cls, host: str = "192.168.4.1", port: int = 100) -> "RobotClient":
        """Get singleton instance of RobotClient."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(host, port)
            return cls._instance

    def connect(self) -> bool:
        """Establish TCP connection to robot."""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(2.0)
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.socket.connect((self.host, self.port))
            print(f"[ROBOT] Connected to {self.host}:{self.port}")
            self.commands_since_connect = 0
            return True
        except Exception as e:
            print(f"[ROBOT] Connection failed: {e}")
            return False

    def disconnect(self):
        """Close TCP connection."""
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.commands_since_connect = 0

    def is_connected(self) -> bool:
        """Check if connected."""
        return self.socket is not None

    def _ensure_fresh_connection(self) -> bool:
        """Reconnect if we've sent too many commands on this connection."""
        if self.socket is None:
            return self.connect()
        if self.commands_since_connect >= self.COMMANDS_PER_CONNECTION:
            print(f"[ROBOT] Proactive reconnect after {self.commands_since_connect} commands")
            self.disconnect()
            self.metrics.reconnections += 1
            return self.connect()
        return True

    def send_raw(self, n: int, d1: int = 0, d2: int = 0, d3: int = 0, d4: int = 0) -> tuple[bool, float, Optional[str]]:
        """Send raw command and return (success, latency_ms, response).

        Uses fire-and-forget mode - ESP32 doesn't reliably ACK commands,
        but they still get through. We only wait briefly to clear buffer.
        """
        with self._command_lock:
            if not self._ensure_fresh_connection():
                self.metrics.record(False, 0)
                return False, 0, None

            start = time.perf_counter()
            try:
                cmd = {"H": "1", "N": n}
                if d1 != 0 or d2 != 0 or d3 != 0 or d4 != 0:
                    cmd["D1"] = d1
                    cmd["D2"] = d2
                    cmd["D3"] = d3
                if d4 != 0:
                    cmd["D4"] = d4

                msg = json.dumps(cmd) + "\n"
                self.socket.sendall(msg.encode())
                self.commands_since_connect += 1

                # Brief non-blocking read to clear any buffered data
                self.socket.settimeout(0.1)
                response = None
                try:
                    data = self.socket.recv(1024)
                    if data:
                        response = data.decode().strip()
                except socket.timeout:
                    pass

                latency_ms = (time.perf_counter() - start) * 1000
                self.metrics.record(True, latency_ms)
                print(f"[ROBOT] Sent N={n} D1={d1} D2={d2} D3={d3} ({latency_ms:.1f}ms)")
                return True, latency_ms, response

            except Exception as e:
                latency_ms = (time.perf_counter() - start) * 1000
                print(f"[ROBOT] Command failed: {e}")
                self.metrics.record(False, latency_ms)
                self.metrics.connection_drops += 1
                self.disconnect()
                return False, latency_ms, None

    # === High-level commands ===

    def drive(self, direction: str, speed: int = 50, duration_ms: int = 0) -> dict:
        """Drive in a direction.

        Args:
            direction: "forward", "backward", "left", "right", "stop"
            speed: 0-100
            duration_ms: If > 0, drive for this duration then stop
        """
        mapped_speed = int((speed / 100) * 250)

        self.send_raw(self.CMD_STANDBY)  # Clear any previous state

        if direction == "forward":
            success, latency, _ = self.send_raw(self.CMD_MOTOR_CONTROL, 0, mapped_speed, self.MOTOR_FORWARD)
        elif direction == "backward":
            success, latency, _ = self.send_raw(self.CMD_MOTOR_CONTROL, 0, mapped_speed, self.MOTOR_BACKWARD)
        elif direction == "left":
            # Turn left while stationary: right forward, left backward
            self.send_raw(self.CMD_MOTOR_CONTROL, 1, mapped_speed, self.MOTOR_FORWARD)
            success, latency, _ = self.send_raw(self.CMD_MOTOR_CONTROL, 2, mapped_speed, self.MOTOR_BACKWARD)
        elif direction == "right":
            # Turn right while stationary: left forward, right backward
            self.send_raw(self.CMD_MOTOR_CONTROL, 2, mapped_speed, self.MOTOR_FORWARD)
            success, latency, _ = self.send_raw(self.CMD_MOTOR_CONTROL, 1, mapped_speed, self.MOTOR_BACKWARD)
        elif direction == "stop":
            return self.stop()
        else:
            return {"success": False, "error": f"Unknown direction: {direction}"}

        if duration_ms > 0:
            time.sleep(duration_ms / 1000.0)
            self.stop()

        return {"success": success, "direction": direction, "speed": speed, "duration_ms": duration_ms}

    def drive_no_wait(self, direction: str, speed: int = 50) -> dict:
        """
        Start driving without waiting - returns immediately.

        Uses CMD_CAR_DIRECTION (N=3) which is designed for sustained directional
        movement. This higher-level command should maintain motion better than
        individual motor control.

        For smooth motion, call this repeatedly (every 150-200ms) with the
        same or new direction.

        Args:
            direction: "forward", "backward", "left", "right"
            speed: 0-100

        Returns:
            dict with success status
        """
        mapped_speed = int((speed / 100) * 250)

        # Use CMD_CAR_DIRECTION for smoother sustained motion
        if direction == "forward":
            success, latency, _ = self.send_raw(self.CMD_CAR_DIRECTION, self.CAR_FORWARD, mapped_speed)
        elif direction == "backward":
            success, latency, _ = self.send_raw(self.CMD_CAR_DIRECTION, self.CAR_BACKWARD, mapped_speed)
        elif direction == "left":
            success, latency, _ = self.send_raw(self.CMD_CAR_DIRECTION, self.CAR_LEFT, mapped_speed)
        elif direction == "right":
            success, latency, _ = self.send_raw(self.CMD_CAR_DIRECTION, self.CAR_RIGHT, mapped_speed)
        else:
            return {"success": False, "error": f"Unknown direction: {direction}"}

        # NO time.sleep() - return immediately
        # NO self.stop() - let motors keep running
        return {"success": success, "direction": direction, "speed": speed}

    def turn(self, degrees: int, speed: int = 50) -> dict:
        """Turn in place.

        Args:
            degrees: Positive = clockwise, negative = counter-clockwise
            speed: 0-100
        """
        mapped_speed = int((speed / 100) * 250)
        duration_ms = abs(degrees) * 10  # ~10ms per degree

        self.send_raw(self.CMD_STANDBY)

        if degrees > 0:
            # Turn right (clockwise): left forward, right backward
            self.send_raw(self.CMD_MOTOR_CONTROL, 2, mapped_speed, self.MOTOR_FORWARD)
            self.send_raw(self.CMD_MOTOR_CONTROL, 1, mapped_speed, self.MOTOR_BACKWARD)
        else:
            # Turn left (counter-clockwise): right forward, left backward
            self.send_raw(self.CMD_MOTOR_CONTROL, 1, mapped_speed, self.MOTOR_FORWARD)
            self.send_raw(self.CMD_MOTOR_CONTROL, 2, mapped_speed, self.MOTOR_BACKWARD)

        time.sleep(duration_ms / 1000.0)
        self.stop()

        return {"success": True, "degrees": degrees, "speed": speed}

    def stop(self) -> dict:
        """Emergency stop all motors."""
        success, latency, _ = self.send_raw(self.CMD_MOTOR_CONTROL, 0, 0, self.MOTOR_STOP)
        self.send_raw(self.CMD_STANDBY)
        return {"success": success}

    def look(self, angle: int) -> dict:
        """Set camera pan servo angle (0-180, 90=center)."""
        angle = max(0, min(180, angle))
        success, latency, _ = self.send_raw(self.CMD_SERVO, 1, angle)
        return {"success": success, "angle": angle}

    def get_distance(self) -> dict:
        """Read ultrasonic distance sensor."""
        success, latency, response = self.send_raw(self.CMD_ULTRASONIC, 1)

        distance = None
        if response:
            try:
                # Response format: {"N":21,"D":123} where D is distance in cm
                data = json.loads(response)
                distance = data.get("D")
            except:
                pass

        return {"success": success, "distance_cm": distance, "raw_response": response}

    def get_line_tracking(self) -> dict:
        """Read line tracking sensors."""
        success, latency, response = self.send_raw(self.CMD_LINE_TRACKING, 1)
        return {"success": success, "raw_response": response}

    def set_led(self, r: int, g: int, b: int, led: int = 0) -> dict:
        """Set LED color (0=all LEDs)."""
        # Note: LED command uses D4 for blue
        success, latency, _ = self.send_raw(self.CMD_LED, led, r, g, b)
        return {"success": success, "r": r, "g": g, "b": b}

    def ping(self) -> dict:
        """Send lightweight ping to check connection."""
        success, latency, response = self.send_raw(self.CMD_GROUND_CHECK)
        return {"success": success, "latency_ms": round(latency, 1)}

    def get_metrics(self) -> dict:
        """Get connection metrics."""
        return self.metrics.to_dict()


# === Camera Stream ===

class CameraStream:
    """Persistent MJPEG stream reader with frame caching.

    Keeps the camera stream open and continuously reads frames in background.
    Control loop can grab the latest frame instantly without HTTP overhead.
    Frame rate is controlled via config.json camera.sample_rate_fps.
    """

    _instance: Optional["CameraStream"] = None
    _lock = threading.Lock()

    def __init__(self, url: str = "http://192.168.4.1:81/stream"):
        self.url = url
        self.latest_frame: Optional[np.ndarray] = None
        self.frame_time: float = 0
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()
        self.error_count = 0
        self.frame_count = 0

        # Load config for frame rate control
        config = load_config()
        camera_config = config.get("camera", {})
        self.sample_rate_fps = camera_config.get("sample_rate_fps", 10)
        self.frame_timeout_s = camera_config.get("frame_timeout_s", 3.0)
        self.min_frame_interval = 1.0 / self.sample_rate_fps if self.sample_rate_fps > 0 else 0
        self.last_stored_time = 0

    @classmethod
    def get_instance(cls, url: str = "http://192.168.4.1:81/stream") -> "CameraStream":
        """Get singleton instance of CameraStream."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(url)
            return cls._instance

    def start(self) -> bool:
        """Start the background stream reader."""
        if self.running:
            return True

        self.running = True
        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()

        # Wait for first frame (configurable timeout)
        wait_iterations = int(self.frame_timeout_s * 10)
        for _ in range(wait_iterations):
            if self.latest_frame is not None:
                print(f"[CAMERA] Stream started at {self.sample_rate_fps} FPS (skip to save CPU)")
                return True
            time.sleep(0.1)

        print(f"[CAMERA] Warning: No frame received in {self.frame_timeout_s}s, continuing anyway")
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

    def get_status(self) -> dict:
        """Get camera stream status."""
        return {
            "running": self.running,
            "frame_count": self.frame_count,
            "error_count": self.error_count,
            "frame_age_ms": round(self.get_frame_age_ms(), 1) if self.frame_time > 0 else None,
            "has_frame": self.latest_frame is not None,
        }

    def _stream_loop(self):
        """Background loop that reads frames from MJPEG stream."""
        import cv2

        while self.running:
            try:
                response = requests.get(self.url, timeout=5.0, stream=True)
                if response.status_code != 200:
                    print(f"[CAMERA] Stream returned {response.status_code}")
                    self.error_count += 1
                    time.sleep(1.0)
                    continue

                # Read MJPEG stream
                buffer = b""
                for chunk in response.iter_content(chunk_size=4096):
                    if not self.running:
                        break

                    buffer += chunk

                    # Look for JPEG frame boundaries
                    start = buffer.find(b'\xff\xd8')  # JPEG start
                    end = buffer.find(b'\xff\xd9')    # JPEG end

                    if start != -1 and end != -1 and end > start:
                        # Extract complete JPEG frame
                        jpg_data = buffer[start:end + 2]
                        buffer = buffer[end + 2:]

                        # Decode JPEG to numpy array
                        frame = cv2.imdecode(
                            np.frombuffer(jpg_data, dtype=np.uint8),
                            cv2.IMREAD_COLOR
                        )

                        if frame is not None:
                            now = time.time()
                            # Rate limiting: only store frame if enough time has passed
                            if now - self.last_stored_time >= self.min_frame_interval:
                                with self.lock:
                                    self.latest_frame = frame
                                    self.frame_time = now
                                self.frame_count += 1
                                self.last_stored_time = now

            except requests.exceptions.Timeout:
                print(f"[CAMERA] Stream timeout, reconnecting...")
                self.error_count += 1
                time.sleep(0.5)
            except Exception as e:
                print(f"[CAMERA] Stream error: {e}")
                self.error_count += 1
                time.sleep(1.0)


# === Convenience functions ===

def get_robot() -> RobotClient:
    """Get the singleton robot client."""
    return RobotClient.get_instance()

def get_camera() -> CameraStream:
    """Get the singleton camera stream."""
    return CameraStream.get_instance()
