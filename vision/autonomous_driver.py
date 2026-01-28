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

# Import shared state modules
from montage import load_nudges, append_decision

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

    # Thresholds (percentages) - with hysteresis
    clear_threshold: float = 35.0
    obstacle_threshold: float = 50.0  # Must exceed this to become obstacle
    obstacle_off_threshold: float = 40.0  # Must fall below this to clear
    danger_threshold: float = 70.0
    wall_variance: float = 12.0

    # Motion commitment (prevents oscillation)
    forward_commitment_ms: int = 1200  # After turn, commit to forward for this long
    wall_reverse_ms: int = 400  # Reverse this long when hitting wall

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

    # Intelligent head scanning (scan when decision is uncertain)
    head_scan_enabled: bool = True
    head_scan_settle_ms: int = 150

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
            self.obstacle_off_threshold = mode_config.get("obstacle_off_threshold", self.obstacle_off_threshold)
            self.danger_threshold = mode_config.get("danger_threshold", self.danger_threshold)
            self.wall_variance = mode_config.get("wall_variance", self.wall_variance)
            self.forward_commitment_ms = mode_config.get("forward_commitment_ms", self.forward_commitment_ms)
            self.wall_reverse_ms = mode_config.get("wall_reverse_ms", self.wall_reverse_ms)

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
        config.obstacle_off_threshold = mode_config.get("obstacle_off_threshold", config.obstacle_off_threshold)
        config.danger_threshold = mode_config.get("danger_threshold", config.danger_threshold)
        config.wall_variance = mode_config.get("wall_variance", config.wall_variance)
        config.forward_commitment_ms = mode_config.get("forward_commitment_ms", config.forward_commitment_ms)
        config.wall_reverse_ms = mode_config.get("wall_reverse_ms", config.wall_reverse_ms)

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

        # Load intelligent head scan settings
        head_scan = data.get("head_scan", {})
        config.head_scan_enabled = head_scan.get("enabled", config.head_scan_enabled)
        config.head_scan_settle_ms = head_scan.get("settle_time_ms", config.head_scan_settle_ms)

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
    consecutive_forwards: int = 0  # Track wall-following patterns
    vision_failures: int = 0
    smoothed_depth: Optional[DepthZones] = None
    turn_count: int = 0
    forward_count: int = 0
    start_time: float = 0.0
    last_snapshot_time: float = 0.0
    snapshot_count: int = 0
    head_swing_count: int = 0
    last_command_time: float = 0.0  # For timed command refresh
    last_head_scan_time: float = 0.0  # Proactive head scanning
    head_scan_count: int = 0
    glance_count: int = 0
    exploration_turns: int = 0  # Track proactive exploration

    # Motion commitment FSM - prevents oscillation
    committed_until: float = 0.0  # Timestamp when commitment ends
    committed_decision: Optional[Decision] = None  # What we're committed to

    # Wall escape sequence - reverse then turn
    wall_escape_turn: Optional[Decision] = None  # Turn to execute after reverse

    # Corner escape escalation - increases reverse/turn intensity on repeated corners
    corner_escape_level: int = 0  # 0=normal, 1=escalated, 2=max
    last_corner_time: float = 0.0  # Track when we last hit a corner

    # Hysteresis state - tracks which zones are "in obstacle mode"
    left_is_obstacle: bool = False
    center_is_obstacle: bool = False
    right_is_obstacle: bool = False


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


# === Proactive Head Scanning ===

class HeadScanScheduler:
    """
    Intelligent head scanning - only scans when truly needed.
    Biased toward driving over data gathering.
    """

    # Quick scan for minor uncertainty (3 angles, ~450ms)
    QUICK_SCAN_ANGLES = [45, 90, 135]
    # Full scan when stuck/circling (5 angles, ~750ms)
    FULL_SCAN_ANGLES = [30, 60, 90, 120, 150]

    def __init__(self, robot: "RobotClient", config: Config, depth_estimator, vision_service_url: str):
        self.robot = robot
        self.config = config
        self.depth_estimator = depth_estimator
        self.vision_service_url = vision_service_url
        self.current_servo_angle = 90
        self.recent_turns: List[str] = []  # Track recent turn directions
        self.max_turn_history = 5
        self.last_scan_time = 0.0
        self.scan_cooldown_s = 3.0  # Minimum time between scans

    def needs_more_data(self, depth: DepthZones, state: DriverState) -> str:
        """
        Check if we need to scan. Returns scan type or empty string.
        Biased toward driving - only scan when truly uncertain.
        """
        if not self.config.head_scan_enabled:
            return ""

        # Cooldown - don't scan too frequently
        if time.time() - self.last_scan_time < self.scan_cooldown_s:
            return ""

        # 1. Repeated same-direction turns (circling) -> FULL scan
        if len(self.recent_turns) >= 4:
            last_4 = self.recent_turns[-4:]
            if all(t == last_4[0] for t in last_4):
                return "full:circling"

        # 2. Very ambiguous direction (within 5%) -> QUICK scan
        # Only when we'd actually need to turn (center has some obstacle)
        if abs(depth.left - depth.right) < 5 and depth.center > 30:
            return "quick:ambiguous"

        # 3. All zones high and similar (stuck at wall) -> FULL scan
        values = [depth.left, depth.center, depth.right]
        if min(values) > 35 and max(values) - min(values) < 8:
            return "full:wall"

        # Default: just drive, don't overthink
        return ""

    def record_turn(self, direction: str):
        """Track turn history for circle detection."""
        self.recent_turns.append(direction)
        if len(self.recent_turns) > self.max_turn_history:
            self.recent_turns.pop(0)

    def decision_scan(self, state: DriverState, reason: str) -> tuple:
        """
        Scan to gather more data. Uses quick (3 angles) or full (5 angles) based on reason.

        Returns: (scan_results dict, center_frame, center_depth_zones)
        The center frame/depth can be used by main loop to avoid double-processing.
        """
        if self.robot is None:
            return None, None, None

        # Choose scan type based on reason prefix
        if reason.startswith("full:"):
            angles = self.FULL_SCAN_ANGLES
            scan_type = "full"
        else:
            angles = self.QUICK_SCAN_ANGLES
            scan_type = "quick"

        print(f"[SCAN] {scan_type} scan ({reason.split(':')[-1]})...")
        results = {}
        center_frame = None
        center_depth_zones = None

        for angle in angles:
            self.robot.look(angle)
            self.current_servo_angle = angle
            time.sleep(self.config.head_scan_settle_ms / 1000.0)

            frame = capture_frame(self.vision_service_url)
            if frame is None:
                continue

            pil_frame = Image.fromarray(frame)
            depth_result = self.depth_estimator.estimate(pil_frame)
            center_depth = depth_result["depth_zones"]["center"] * 100
            results[angle] = center_depth

            # Keep the center (90°) frame for main loop to use
            if angle == 90:
                center_frame = frame
                center_depth_zones = DepthZones(
                    left=depth_result["depth_zones"]["left"] * 100,
                    center=depth_result["depth_zones"]["center"] * 100,
                    right=depth_result["depth_zones"]["right"] * 100,
                )

        # Return to center
        self.robot.look(90)
        self.current_servo_angle = 90

        self.last_scan_time = time.time()
        state.last_head_scan_time = time.time()
        state.head_scan_count += 1

        if results:
            angles_str = " ".join([f"{a}°:{d:.0f}%" for a, d in sorted(results.items())])
            print(f"[SCAN] Results: {angles_str}")

        return results, center_frame, center_depth_zones

    def get_best_direction_from_scan(self, scan_results: dict, bias_against: str = None) -> Optional[str]:
        """
        Determine best direction from scan results.
        Can bias against a direction (e.g., if we've been turning left repeatedly).
        """
        if not scan_results:
            return None

        # Find clearest angle (lowest depth %)
        best_angle = min(scan_results, key=scan_results.get)
        best_depth = scan_results[best_angle]

        # If biasing against a direction, penalize that side
        if bias_against:
            penalty = 15  # Add 15% penalty to discouraged side
            adjusted = {}
            for angle, depth in scan_results.items():
                if bias_against == "left" and angle < 90:
                    adjusted[angle] = depth + penalty
                elif bias_against == "right" and angle > 90:
                    adjusted[angle] = depth + penalty
                else:
                    adjusted[angle] = depth
            best_angle = min(adjusted, key=adjusted.get)
            best_depth = scan_results[best_angle]
            print(f"[SCAN] Biasing against {bias_against}, adjusted best: {best_angle}°")

        # Determine direction
        center_depth = scan_results.get(90, 100)

        # Need significant improvement to suggest turn
        if best_depth < center_depth - 8:
            if best_angle < 90:
                return "left"
            elif best_angle > 90:
                return "right"

        # Center is fine
        return None

    def get_circle_bias(self) -> Optional[str]:
        """If we've been circling, return direction to bias against."""
        if len(self.recent_turns) < 3:
            return None

        left_count = self.recent_turns.count("left")
        right_count = self.recent_turns.count("right")

        # If 70%+ turns in one direction, bias against it (was 80%)
        total = left_count + right_count
        if total > 0:
            if left_count / total >= 0.7:
                return "left"
            if right_count / total >= 0.7:
                return "right"

        return None

    def should_force_opposite(self, depth: "DepthZones", config: "Config") -> Optional[str]:
        """
        If we've been turning same direction 3+ times, suggest the opposite.
        But ONLY if that direction is actually clear (below obstacle_threshold).
        Uses obstacle_threshold not danger_threshold to prevent forcing into blocked areas.
        """
        if len(self.recent_turns) < 3:
            return None

        last_3 = self.recent_turns[-3:]
        if all(t == "left" for t in last_3):
            # Only suggest right if right is actually clear (not just "not danger")
            if depth.right < config.obstacle_threshold:
                print("[CIRCLE] 3 consecutive lefts - suggesting RIGHT")
                return "right"
            else:
                print(f"[CIRCLE] 3 lefts but right={depth.right:.0f}% blocked, continuing left")
                return None
        if all(t == "right" for t in last_3):
            # Only suggest left if left is actually clear
            if depth.left < config.obstacle_threshold:
                print("[CIRCLE] 3 consecutive rights - suggesting LEFT")
                return "left"
            else:
                print(f"[CIRCLE] 3 rights but left={depth.left:.0f}% blocked, continuing right")
                return None

        return None


# === Visit Tracking (Loop Prevention) ===

class VisitTracker:
    """
    Micromouse-inspired position tracking and loop prevention.
    Uses dead reckoning + grid cells to know where we've been.
    """

    CELL_SIZE_CM = 30  # Grid cell size (robot is ~15cm wide)
    FORWARD_DISTANCE_CM = 8  # Estimated distance per forward command

    def __init__(self):
        self.x = 0.0  # Position in cm
        self.y = 0.0
        self.heading = 0.0  # Degrees, 0 = forward at start
        self.visited: dict = {}  # {(cell_x, cell_y): visit_count}
        self.total_distance = 0.0

    def _get_cell(self) -> tuple:
        """Get current grid cell coordinates."""
        cx = int(self.x / self.CELL_SIZE_CM)
        cy = int(self.y / self.CELL_SIZE_CM)
        return (cx, cy)

    def update(self, decision: "Decision", config: "Config"):
        """Update position estimate based on executed decision."""
        import math

        if decision in (Decision.FORWARD, Decision.FORWARD_SLOW):
            # Move forward in current heading direction
            distance = self.FORWARD_DISTANCE_CM
            rad = math.radians(self.heading)
            self.x += distance * math.sin(rad)
            self.y += distance * math.cos(rad)
            self.total_distance += distance

        elif decision == Decision.REVERSE:
            # Move backward
            distance = self.FORWARD_DISTANCE_CM * 0.6
            rad = math.radians(self.heading)
            self.x -= distance * math.sin(rad)
            self.y -= distance * math.cos(rad)

        elif decision == Decision.TURN_LEFT:
            self.heading = (self.heading - config.turn_degrees_small) % 360

        elif decision == Decision.TURN_RIGHT:
            self.heading = (self.heading + config.turn_degrees_small) % 360

        elif decision == Decision.TURN_LEFT_LARGE:
            self.heading = (self.heading - config.turn_degrees_large) % 360

        elif decision == Decision.TURN_RIGHT_LARGE:
            self.heading = (self.heading + config.turn_degrees_large) % 360

        # Record visit to current cell
        cell = self._get_cell()
        self.visited[cell] = self.visited.get(cell, 0) + 1

    def get_visit_count(self) -> int:
        """Get visit count for current cell."""
        return self.visited.get(self._get_cell(), 0)

    def get_exploration_score(self, direction: str) -> float:
        """
        Get exploration score for a direction (lower = less explored = better).
        Projects where we'd end up if we went that direction.
        """
        import math

        # Project position if we went that direction
        if direction == "forward":
            test_heading = self.heading
        elif direction == "left":
            test_heading = (self.heading - 30) % 360
        elif direction == "right":
            test_heading = (self.heading + 30) % 360
        else:
            return 0.0

        # Where would we be after moving?
        rad = math.radians(test_heading)
        test_x = self.x + self.FORWARD_DISTANCE_CM * 2 * math.sin(rad)
        test_y = self.y + self.FORWARD_DISTANCE_CM * 2 * math.cos(rad)

        test_cell = (int(test_x / self.CELL_SIZE_CM), int(test_y / self.CELL_SIZE_CM))
        return self.visited.get(test_cell, 0)

    def suggest_direction(self, depth: "DepthZones", config: "Config") -> Optional[str]:
        """
        Suggest a direction based on exploration (prefer unexplored areas).
        Only suggests if there's a meaningful difference and path is clear.
        """
        left_score = self.get_exploration_score("left")
        right_score = self.get_exploration_score("right")
        forward_score = self.get_exploration_score("forward")

        # Only suggest if one direction is significantly less explored
        min_score = min(left_score, right_score, forward_score)
        scores = {"left": left_score, "right": right_score, "forward": forward_score}

        # Find directions that are least explored (within 1 visit of minimum)
        best_dirs = [d for d, s in scores.items() if s <= min_score + 1]

        # Filter by what's actually clear
        clear_dirs = []
        for d in best_dirs:
            if d == "forward" and depth.center < config.obstacle_threshold:
                clear_dirs.append(d)
            elif d == "left" and depth.left < config.obstacle_threshold:
                clear_dirs.append(d)
            elif d == "right" and depth.right < config.obstacle_threshold:
                clear_dirs.append(d)

        if not clear_dirs:
            return None

        # Prefer forward if it's among the best
        if "forward" in clear_dirs:
            return None  # Let normal logic handle forward

        # Otherwise suggest least explored clear direction
        return clear_dirs[0] if clear_dirs else None

    def is_stuck_in_area(self, threshold: int = 5) -> bool:
        """Check if we've visited current cell too many times."""
        return self.get_visit_count() >= threshold

    def should_explore(self) -> Optional[str]:
        """
        Proactive exploration: occasionally suggest turning toward unexplored areas
        even when forward is clear. This breaks the "follow walls in circles" pattern.

        Returns: "left", "right", or None
        """
        import random

        # Only suggest exploration every ~10 forward moves (10% chance)
        if random.random() > 0.10:
            return None

        left_score = self.get_exploration_score("left")
        right_score = self.get_exploration_score("right")
        forward_score = self.get_exploration_score("forward")

        # Only explore if a side is significantly less visited than forward
        min_side = min(left_score, right_score)
        if min_side >= forward_score:
            return None  # Forward is as good or better

        # Bias toward the less explored side
        if left_score < right_score - 1:
            return "left"
        elif right_score < left_score - 1:
            return "right"

        # Both sides similar and better than forward - random choice
        return "left" if random.random() > 0.5 else "right"

    def get_stats(self) -> dict:
        """Get tracking statistics."""
        return {
            "position": (round(self.x, 1), round(self.y, 1)),
            "heading": round(self.heading, 1),
            "cells_visited": len(self.visited),
            "total_distance_cm": round(self.total_distance, 1),
            "current_cell_visits": self.get_visit_count(),
        }


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


# === Nudge System (Claude Copilot) ===

NUDGES_PATH = Path(__file__).parent / "nudges.json"

def load_nudges() -> dict:
    """Load navigation nudges from Claude."""
    try:
        if NUDGES_PATH.exists():
            with open(NUDGES_PATH) as f:
                return json.load(f)
    except Exception as e:
        print(f"[NUDGE] Error loading nudges: {e}")
    return {"active": False}


def apply_nudge_bias(decision: "Decision", depth: "DepthZones", nudges: dict) -> "Decision":
    """Apply Claude's navigation nudges to bias the decision."""
    if not nudges.get("active", False):
        return decision

    prefer = nudges.get("prefer_direction")
    bias = nudges.get("bias_strength", 0.3)

    # Only apply nudge when there's a choice (not in danger/wall situations)
    if decision in (Decision.STOP, Decision.REVERSE):
        return decision

    # Bias toward preferred direction when both sides are similar
    if prefer == "left":
        if decision == Decision.TURN_RIGHT and depth.left < depth.right + (bias * 100):
            print(f"[NUDGE] Biasing left (Claude preference)")
            return Decision.TURN_LEFT
        if decision == Decision.TURN_RIGHT_LARGE and depth.left < depth.right + (bias * 100):
            return Decision.TURN_LEFT_LARGE
        # Prefer turning left when going forward and sides are balanced
        if decision in (Decision.FORWARD, Decision.FORWARD_SLOW):
            if abs(depth.left - depth.right) < 15:  # Balanced
                return decision  # Keep going, but next turn will prefer left

    elif prefer == "right":
        if decision == Decision.TURN_LEFT and depth.right < depth.left + (bias * 100):
            print(f"[NUDGE] Biasing right (Claude preference)")
            return Decision.TURN_RIGHT
        if decision == Decision.TURN_LEFT_LARGE and depth.right < depth.left + (bias * 100):
            return Decision.TURN_RIGHT_LARGE

    return decision


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


def apply_hysteresis(depth: DepthZones, state: DriverState, config: Config) -> tuple:
    """
    Apply hysteresis to depth readings to prevent oscillation.
    Returns (left_blocked, center_blocked, right_blocked) booleans.

    A zone becomes "blocked" when it exceeds obstacle_threshold.
    It becomes "clear" only when it falls below obstacle_off_threshold.
    """
    # Update left
    if depth.left > config.obstacle_threshold:
        state.left_is_obstacle = True
    elif depth.left < config.obstacle_off_threshold:
        state.left_is_obstacle = False

    # Update center
    if depth.center > config.obstacle_threshold:
        state.center_is_obstacle = True
    elif depth.center < config.obstacle_off_threshold:
        state.center_is_obstacle = False

    # Update right
    if depth.right > config.obstacle_threshold:
        state.right_is_obstacle = True
    elif depth.right < config.obstacle_off_threshold:
        state.right_is_obstacle = False

    return (state.left_is_obstacle, state.center_is_obstacle, state.right_is_obstacle)


def is_wall_pattern(depth: DepthZones, config: Config) -> bool:
    """Check if depth pattern indicates a wall (all zones similar and high)."""
    values = [depth.left, depth.center, depth.right]
    return max(values) - min(values) < config.wall_variance and min(values) > config.obstacle_threshold


def is_narrow_passage(depth: DepthZones, state: DriverState, config: Config) -> bool:
    """Check if depth pattern indicates a narrow passage."""
    return (
        state.left_is_obstacle and
        state.right_is_obstacle and
        not state.center_is_obstacle and
        depth.center < config.clear_threshold
    )


def is_corner_pattern(depth: DepthZones, config: Config) -> bool:
    """
    Detect corner situations that wall_pattern misses.
    Corners often have: left blocked, right blocked, center not-clear.
    Unlike walls, corners have more variance (one side usually closer than other).
    """
    left_blocked = depth.left > config.obstacle_threshold
    right_blocked = depth.right > config.obstacle_threshold
    center_not_clear = depth.center > config.clear_threshold

    # Both sides blocked AND center not clear = corner trap
    return left_blocked and right_blocked and center_not_clear


def make_decision(depth: DepthZones, state: DriverState, config: Config) -> Decision:
    """
    Make navigation decision based on depth zones with hysteresis.
    Uses enter/exit thresholds to prevent oscillation.
    """
    import random

    # Apply hysteresis to get stable blocked/clear state
    left_blocked, center_blocked, right_blocked = apply_hysteresis(depth, state, config)

    left, center, right = depth.left, depth.center, depth.right

    # DANGER: Very close obstacle - always stop (no hysteresis, safety critical)
    if center > config.danger_threshold:
        return Decision.STOP

    # Wall detected - needs special handling (reverse first)
    # Return a special marker that the main loop will handle
    if is_wall_pattern(depth, config):
        # Pick direction based on which side is slightly clearer, with randomness
        if abs(left - right) < 5:
            go_left = random.random() > 0.5
        else:
            go_left = left < right
        return Decision.TURN_LEFT_LARGE if go_left else Decision.TURN_RIGHT_LARGE

    # Narrow passage - proceed slowly
    if is_narrow_passage(depth, state, config):
        return Decision.FORWARD_SLOW

    # Center blocked - turn toward clearer side
    if center_blocked:
        # Use actual depth values to pick direction, not just blocked state
        if abs(left - right) < 10:
            # Ambiguous - random choice to break patterns
            go_left = random.random() > 0.5
        else:
            go_left = left < right

        if go_left:
            return Decision.TURN_LEFT if not left_blocked else Decision.TURN_LEFT_LARGE
        else:
            return Decision.TURN_RIGHT if not right_blocked else Decision.TURN_RIGHT_LARGE

    # Left blocked only
    if left_blocked and not right_blocked:
        return Decision.TURN_RIGHT

    # Right blocked only
    if right_blocked and not left_blocked:
        return Decision.TURN_LEFT

    # Both sides blocked but center clear (narrow)
    if left_blocked and right_blocked and not center_blocked:
        return Decision.FORWARD_SLOW

    # Some obstruction sensed but not "blocked" yet - slow down
    if left > config.clear_threshold or right > config.clear_threshold:
        return Decision.FORWARD_SLOW

    # All clear - full speed ahead
    return Decision.FORWARD


def execute_decision(decision: Decision, robot: RobotClient, config: Config) -> bool:
    """
    Execute a navigation decision using smooth continuous motion.

    Uses drive_no_wait() for forward/backward - sends CMD_MOTOR_CONTROL.
    """
    result = None

    if decision == Decision.FORWARD:
        result = robot.drive_no_wait("forward", config.cruise_speed)
    elif decision == Decision.FORWARD_SLOW:
        result = robot.drive_no_wait("forward", config.slow_speed)
    elif decision == Decision.REVERSE:
        result = robot.drive_no_wait("backward", config.reverse_speed)
    elif decision == Decision.TURN_LEFT:
        result = robot.turn(-config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_RIGHT:
        result = robot.turn(config.turn_degrees_small, config.turn_speed)
    elif decision == Decision.TURN_LEFT_LARGE:
        result = robot.turn(-config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.TURN_RIGHT_LARGE:
        result = robot.turn(config.turn_degrees_large, config.turn_speed)
    elif decision == Decision.STOP:
        result = robot.stop()
    else:
        result = robot.stop()

    return result.get("success", False) if isinstance(result, dict) else bool(result)


# === Snapshot Cleanup ===

def cleanup_snapshots(config: Config):
    """Clear old snapshots at session start/end."""
    snapshot_dir = Path(CONFIG_PATH).parent / config.snapshots_path
    if snapshot_dir.exists():
        count = 0
        for f in snapshot_dir.glob("*.jpg"):
            f.unlink()
            count += 1
        if count > 0:
            print(f"[CLEANUP] Removed {count} old snapshots")


# === Main Driver Loop ===

def run_driver(duration_s: int, config: Config, dry_run: bool = False):
    """Main autonomous driving loop."""

    if not VISION_AVAILABLE:
        print("[ERROR] Vision models not available")
        return

    # Initialize
    print("[DRIVER] Initializing...")

    # Clean up old snapshots from previous sessions
    cleanup_snapshots(config)
    depth_estimator = DepthEstimator()

    state = DriverState(
        start_time=time.time(),
        smoothed_depth=DepthZones(left=25, center=14, right=25),  # baseline
    )

    robot: Optional[RobotClient] = None
    head_scanner: Optional[HeadScanScheduler] = None
    visit_tracker = VisitTracker()  # Always track, even in dry-run

    if not dry_run:
        robot = RobotClient(config.robot_host, config.robot_port)
        if not robot.connect():
            print("[ERROR] Could not connect to robot")
            return
        # Initialize intelligent head scanner
        head_scanner = HeadScanScheduler(robot, config, depth_estimator, config.vision_service_url)
        print(f"[DRIVER] Intelligent head scanning: {'enabled' if config.head_scan_enabled else 'disabled'}")

    # Signal handler for clean shutdown
    def signal_handler(sig, frame):
        print("\n[DRIVER] Interrupted, stopping...")
        state.running = False

    signal.signal(signal.SIGINT, signal_handler)

    end_time = time.time() + duration_s
    print(f"[DRIVER] Starting for {duration_s}s...")

    # Pre-launch scan - look around before first move
    if head_scanner and not dry_run:
        print("[DRIVER] Pre-launch scan...")
        scan_results, _, _ = head_scanner.decision_scan(state, "full:prelaunch")
        if scan_results:
            best_dir = head_scanner.get_best_direction_from_scan(scan_results)
            if best_dir:
                print(f"[DRIVER] Best initial direction: {best_dir}")
                # Execute initial turn toward clearest path
                if best_dir == "left":
                    robot.turn(-config.turn_degrees_small, config.turn_speed)
                else:
                    robot.turn(config.turn_degrees_small, config.turn_speed)

    try:
        while state.running and time.time() < end_time:
            loop_start = time.time()

            # Hot-reload config if file changed (tune without restart!)
            config.hot_reload()

            frame = None
            current_depth = None
            scan_direction_override = None  # If scan finds better path

            # === Intelligent Head Scanning ===
            # Check if we need more data BEFORE capturing a frame
            # If we scan, we get the center frame for free - no double processing
            if head_scanner and not dry_run and state.smoothed_depth:
                scan_reason = head_scanner.needs_more_data(state.smoothed_depth, state)

                if scan_reason:
                    # Do a wide decision scan - returns center frame too
                    scan_results, scan_frame, scan_depth = head_scanner.decision_scan(state, scan_reason)

                    if scan_results and scan_frame is not None:
                        # Use the center frame from scan - no extra capture needed!
                        frame = scan_frame
                        current_depth = scan_depth

                        # Check if we should bias against a direction (circle prevention)
                        circle_bias = head_scanner.get_circle_bias()
                        if circle_bias:
                            print(f"[SCAN] Detected circling {circle_bias}, biasing against")

                        scan_direction_override = head_scanner.get_best_direction_from_scan(
                            scan_results, bias_against=circle_bias
                        )

                        if scan_direction_override:
                            print(f"[SCAN] Best path: {scan_direction_override}")

            # Only capture a new frame if we didn't just do a scan
            if frame is None:
                frame = capture_frame(config.vision_service_url)
                if frame is None:
                    state.vision_failures += 1
                    if state.vision_failures > config.max_vision_failures:
                        print("[DRIVER] Too many vision failures, stopping")
                        break
                    time.sleep(config.loop_interval_ms / 1000.0)
                    continue

            state.vision_failures = 0

            # Only process depth if we didn't get it from scan
            if current_depth is None:
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

            # === Motion Commitment FSM ===
            # If we're committed to a motion, honor it unless obstacle/danger
            # Supports multi-phase sequences (e.g., wall escape: REVERSE -> TURN -> FORWARD)
            now = time.time()
            if state.committed_until > now and state.committed_decision:
                # Still in commitment window - check for breaking conditions
                if state.smoothed_depth.center > config.danger_threshold:
                    # DANGER overrides any commitment - STOP immediately
                    print("[COMMIT] Breaking commitment - DANGER detected")
                    state.committed_until = 0
                    state.committed_decision = None
                    state.wall_escape_turn = None  # Clear wall escape sequence
                    decision = Decision.STOP
                elif (state.committed_decision in (Decision.FORWARD, Decision.FORWARD_SLOW)
                      and state.smoothed_depth.center > config.obstacle_threshold):
                    # OBSTACLE during forward commitment - break and make fresh decision
                    # This prevents pushing into obstacles during forward commitment
                    print(f"[COMMIT] Breaking forward commitment - obstacle at {state.smoothed_depth.center:.0f}%")
                    state.committed_until = 0
                    state.committed_decision = None
                    # Make fresh decision (will be TURN or STOP based on depth)
                    decision = make_decision(state.smoothed_depth, state, config)
                else:
                    # Honor commitment
                    decision = state.committed_decision
            else:
                # Commitment expired - check for pending wall escape turn
                if state.wall_escape_turn:
                    # Reverse phase complete, now do the turn
                    decision = state.wall_escape_turn
                    print(f"[WALL] Reverse complete, now turning: {decision.value}")
                    state.wall_escape_turn = None
                    # Commit to forward motion after the turn
                    state.committed_decision = Decision.FORWARD
                    state.committed_until = now + (config.forward_commitment_ms / 1000.0)
                    print(f"[COMMIT] Will drive forward for {config.forward_commitment_ms}ms after turn")
                else:
                    # Not committed - make fresh decision
                    state.committed_decision = None

                    # === Decision Tracing ===
                    # Track each step for debugging weird decisions
                    decision_trace = []

                    # Decide based on depth (with hysteresis)
                    decision = make_decision(state.smoothed_depth, state, config)
                    decision_trace.append(f"base:{decision.value}")

                    # === Wall Handling: Reverse First (via commitment FSM) ===
                    # Walls require backing up to change geometry, then turning
                    # Instead of direct motor calls, use the commitment FSM for sequencing
                    if is_wall_pattern(state.smoothed_depth, config) and not dry_run:
                        print("[WALL] Detected - committing to reverse sequence")
                        # Store the turn to do after reverse
                        state.wall_escape_turn = decision  # TURN_*_LARGE from make_decision
                        # Commit to REVERSE for wall_reverse_ms
                        decision = Decision.REVERSE
                        state.committed_decision = Decision.REVERSE
                        state.committed_until = now + (config.wall_reverse_ms / 1000.0)
                        decision_trace.append("wall:REVERSE")

                    # === Corner Handling: Escalating Escape ===
                    # Corners are missed by wall_pattern due to variance, so detect separately
                    # Escalate reverse/turn intensity on repeated corner hits
                    elif is_corner_pattern(state.smoothed_depth, config) and not dry_run:
                        # Track escalation - if we hit corner within 5s, escalate
                        if now - state.last_corner_time < 5.0:
                            state.corner_escape_level = min(state.corner_escape_level + 1, 2)
                        else:
                            state.corner_escape_level = 0  # Reset if it's been a while
                        state.last_corner_time = now

                        # Escalating reverse duration: 600ms -> 900ms -> 1200ms
                        reverse_ms = [600, 900, 1200][state.corner_escape_level]
                        # Use LARGE turns for corners (they need more angle to escape)
                        turn_decision = Decision.TURN_LEFT_LARGE if decision in (
                            Decision.TURN_LEFT, Decision.TURN_LEFT_LARGE
                        ) else Decision.TURN_RIGHT_LARGE

                        print(f"[CORNER] Detected (level {state.corner_escape_level}) - "
                              f"reverse {reverse_ms}ms then {turn_decision.value}")

                        state.wall_escape_turn = turn_decision
                        decision = Decision.REVERSE
                        state.committed_decision = Decision.REVERSE
                        state.committed_until = now + (reverse_ms / 1000.0)
                        decision_trace.append(f"corner:REVERSE(L{state.corner_escape_level})")

                    # After any turn, commit to forward motion to prevent oscillation
                    elif decision in (Decision.TURN_LEFT, Decision.TURN_RIGHT,
                                      Decision.TURN_LEFT_LARGE, Decision.TURN_RIGHT_LARGE):
                        state.committed_decision = Decision.FORWARD
                        state.committed_until = now + (config.forward_commitment_ms / 1000.0)

            # Apply Claude's nudges (copilot mode)
            nudges = load_nudges()
            pre_nudge = decision
            decision = apply_nudge_bias(decision, state.smoothed_depth, nudges)
            if decision != pre_nudge and 'decision_trace' in dir():
                decision_trace.append(f"nudge:{decision.value}")

            # Override with scan result if scan found a better path
            if scan_direction_override:
                if scan_direction_override == "left":
                    decision = Decision.TURN_LEFT
                    if 'decision_trace' in dir():
                        decision_trace.append("scan:LEFT")
                else:
                    decision = Decision.TURN_RIGHT
                    if 'decision_trace' in dir():
                        decision_trace.append("scan:RIGHT")

            # Circle detection: BIAS (not override) toward opposite direction
            # NOTE: record_turn() is now called AFTER all overrides (see below)
            # Only apply when both directions are safe and similar - don't override
            # legitimate obstacle avoidance when one side is clearly blocked
            if head_scanner and not dry_run:
                suggest_dir = head_scanner.should_force_opposite(state.smoothed_depth, config)
                if suggest_dir and decision in (Decision.TURN_LEFT, Decision.TURN_RIGHT,
                                                Decision.TURN_LEFT_LARGE, Decision.TURN_RIGHT_LARGE):
                    # Only apply as tie-breaker when both sides are safe
                    left_safe = state.smoothed_depth.left < config.obstacle_threshold
                    right_safe = state.smoothed_depth.right < config.obstacle_threshold
                    # And they're similar (within 15% - ambiguous territory)
                    sides_similar = abs(state.smoothed_depth.left - state.smoothed_depth.right) < 15

                    if left_safe and right_safe and sides_similar:
                        if suggest_dir == "left" and decision in (Decision.TURN_RIGHT, Decision.TURN_RIGHT_LARGE):
                            print(f"[CIRCLE] Bias: switching from right to left (tie-breaker)")
                            decision = Decision.TURN_LEFT
                            if 'decision_trace' in dir():
                                decision_trace.append("circle:LEFT")
                        elif suggest_dir == "right" and decision in (Decision.TURN_LEFT, Decision.TURN_LEFT_LARGE):
                            print(f"[CIRCLE] Bias: switching from left to right (tie-breaker)")
                            decision = Decision.TURN_RIGHT
                            if 'decision_trace' in dir():
                                decision_trace.append("circle:RIGHT")
                    else:
                        # Log why we didn't apply circle-breaking
                        if suggest_dir and not (left_safe and right_safe):
                            print(f"[CIRCLE] Ignoring (one side blocked): L={state.smoothed_depth.left:.0f}% R={state.smoothed_depth.right:.0f}%")

            # === Visit Tracking (Loop Prevention) ===
            # Always bias toward unexplored areas when making turn decisions
            if decision in (Decision.TURN_LEFT, Decision.TURN_RIGHT):
                # Check if the opposite direction is significantly less explored
                left_score = visit_tracker.get_exploration_score("left")
                right_score = visit_tracker.get_exploration_score("right")

                # Switch direction if other side is much less explored AND clear
                if decision == Decision.TURN_LEFT and right_score < left_score - 2:
                    if state.smoothed_depth.right < config.obstacle_threshold:
                        print(f"[EXPLORE] Right less explored ({right_score} vs {left_score}), switching")
                        decision = Decision.TURN_RIGHT
                        if 'decision_trace' in dir():
                            decision_trace.append("visit:RIGHT")
                elif decision == Decision.TURN_RIGHT and left_score < right_score - 2:
                    if state.smoothed_depth.left < config.obstacle_threshold:
                        print(f"[EXPLORE] Left less explored ({left_score} vs {right_score}), switching")
                        decision = Decision.TURN_LEFT
                        if 'decision_trace' in dir():
                            decision_trace.append("visit:LEFT")

            # Force exploration when stuck in same cell too long
            if visit_tracker.is_stuck_in_area(threshold=5):
                explore_dir = visit_tracker.suggest_direction(state.smoothed_depth, config)
                if explore_dir and explore_dir != "forward":
                    print(f"[EXPLORE] Stuck ({visit_tracker.get_visit_count()} visits), forcing {explore_dir}")
                    if explore_dir == "left":
                        decision = Decision.TURN_LEFT_LARGE
                        if 'decision_trace' in dir():
                            decision_trace.append("stuck:LEFT_L")
                    else:
                        decision = Decision.TURN_RIGHT_LARGE
                        if 'decision_trace' in dir():
                            decision_trace.append("stuck:RIGHT_L")

            # Check if we should do head swing to find better path (reactive - stuck/wall)
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
                            if 'decision_trace' in dir():
                                decision_trace.append("swing:LEFT_L")
                        elif best_angle > 90:  # Right is clearer
                            decision = Decision.TURN_RIGHT_LARGE
                            if 'decision_trace' in dir():
                                decision_trace.append("swing:RIGHT_L")
                        else:  # Center is clearest, reverse a bit then go
                            decision = Decision.REVERSE
                            if 'decision_trace' in dir():
                                decision_trace.append("swing:REVERSE")
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

            # === Proactive Exploration ===
            # When going forward, occasionally explore unexplored directions
            # This breaks the "follow walls in circles" pattern
            if decision in (Decision.FORWARD, Decision.FORWARD_SLOW):
                import random

                state.consecutive_forwards += 1
                explore_dir = None

                # FORCE exploration after 15+ consecutive forwards (wall-following pattern)
                # ~3 seconds of straight driving is likely following a wall
                if state.consecutive_forwards >= 15:
                    left_score = visit_tracker.get_exploration_score("left")
                    right_score = visit_tracker.get_exploration_score("right")
                    if left_score < right_score and state.smoothed_depth.left < config.obstacle_threshold:
                        explore_dir = "left"
                    elif state.smoothed_depth.right < config.obstacle_threshold:
                        explore_dir = "right"
                    if explore_dir:
                        print(f"[EXPLORE] FORCED turn {explore_dir} after {state.consecutive_forwards} consecutive forwards")
                        state.consecutive_forwards = 0

                # Regular curiosity exploration (10% chance per forward)
                if not explore_dir:
                    explore_dir = visit_tracker.should_explore()

                if explore_dir:
                    # Check if that direction is clear enough
                    if explore_dir == "left" and state.smoothed_depth.left < config.obstacle_threshold:
                        if state.consecutive_forwards < 15:  # Not forced
                            print(f"[EXPLORE] Curiosity turn left (proactive)")
                        decision = Decision.TURN_LEFT
                        state.exploration_turns += 1
                        state.consecutive_forwards = 0
                        if 'decision_trace' in dir():
                            decision_trace.append("explore:LEFT")
                    elif explore_dir == "right" and state.smoothed_depth.right < config.obstacle_threshold:
                        if state.consecutive_forwards < 15:  # Not forced
                            print(f"[EXPLORE] Curiosity turn right (proactive)")
                        decision = Decision.TURN_RIGHT
                        state.exploration_turns += 1
                        state.consecutive_forwards = 0
                        if 'decision_trace' in dir():
                            decision_trace.append("explore:RIGHT")
            else:
                # Reset consecutive forwards on any turn/stop
                state.consecutive_forwards = 0

            # Track stats
            if decision in (Decision.FORWARD, Decision.FORWARD_SLOW):
                state.forward_count += 1
            if decision.name.startswith("TURN"):
                state.turn_count += 1

            # Record turns for circle detection AFTER all overrides
            # This ensures recent_turns reflects actual executed decisions
            if head_scanner and not dry_run:
                if decision in (Decision.TURN_LEFT, Decision.TURN_LEFT_LARGE):
                    head_scanner.record_turn("left")
                elif decision in (Decision.TURN_RIGHT, Decision.TURN_RIGHT_LARGE):
                    head_scanner.record_turn("right")

            # Log decision trace if there were overrides
            if 'decision_trace' in dir() and len(decision_trace) > 1:
                print(f"[TRACE] {' → '.join(decision_trace)} → final:{decision.value}")

            # Write to decision queue for dashboard visualization
            # Only write interesting decisions (not every forward)
            if 'decision_trace' in dir():
                is_interesting = (
                    len(decision_trace) > 1 or  # Had overrides
                    decision not in (Decision.FORWARD, Decision.FORWARD_SLOW) or  # Not forward
                    state.committed_decision is not None  # In commitment
                )
                if is_interesting:
                    append_decision({
                        "depth": {
                            "left": round(state.smoothed_depth.left, 1),
                            "center": round(state.smoothed_depth.center, 1),
                            "right": round(state.smoothed_depth.right, 1),
                        },
                        "trace": decision_trace,
                        "final": decision.value,
                        "committed": state.committed_decision.value if state.committed_decision else None,
                        "corner_level": state.corner_escape_level,
                    })

            # Execute every loop - motor commands need to be refreshed
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

            # Update position estimate for loop prevention
            visit_tracker.update(decision, config)

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
        print(f"  Snapshots:      {state.snapshot_count}")
        print(f"  Vision fails:   {state.vision_failures}")

        print(f"\nHead Movement:")
        print(f"  Periodic scans: {state.head_scan_count}")
        print(f"  Turn glances:   {state.glance_count}")
        print(f"  Reactive swings:{state.head_swing_count}")

        # Visit tracking stats
        vt_stats = visit_tracker.get_stats()
        print(f"\nExploration:")
        print(f"  Curiosity turns:{state.exploration_turns}")
        print(f"  Est. position:  ({vt_stats['position'][0]}, {vt_stats['position'][1]}) cm")
        print(f"  Est. heading:   {vt_stats['heading']}°")
        print(f"  Cells visited:  {vt_stats['cells_visited']}")
        print(f"  Total distance: {vt_stats['total_distance_cm']} cm")

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
