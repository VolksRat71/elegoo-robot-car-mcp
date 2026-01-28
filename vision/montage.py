#!/usr/bin/env python3
"""
Montage Generator for Claude Copilot Mode.

Compiles recent drive snapshots into a grid image for Claude to review.
"""

import base64
import io
import json
from pathlib import Path
from typing import Optional, List
from PIL import Image, ImageDraw, ImageFont

SNAPSHOTS_DIR = Path(__file__).parent / "drive_snapshots"
NUDGES_PATH = Path(__file__).parent / "nudges.json"


def get_recent_snapshots(count: int = 6) -> List[Path]:
    """Get the N most recent snapshots."""
    if not SNAPSHOTS_DIR.exists():
        return []

    snapshots = sorted(SNAPSHOTS_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
    return snapshots[-count:]


def create_montage(snapshots: List[Path], cols: int = 3, thumb_size: int = 320) -> Optional[Image.Image]:
    """Create a grid montage from snapshot images."""
    if not snapshots:
        return None

    # Calculate grid dimensions
    rows = (len(snapshots) + cols - 1) // cols
    width = cols * thumb_size
    height = rows * (thumb_size + 30)  # Extra space for labels

    # Create montage canvas
    montage = Image.new('RGB', (width, height), color='black')
    draw = ImageDraw.Draw(montage)

    # Try to load a font, fall back to default
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
    except:
        font = ImageFont.load_default()

    for i, snap_path in enumerate(snapshots):
        row = i // cols
        col = i % cols
        x = col * thumb_size
        y = row * (thumb_size + 30)

        try:
            img = Image.open(snap_path)
            img.thumbnail((thumb_size, thumb_size), Image.Resampling.LANCZOS)

            # Center the thumbnail in its cell
            x_offset = x + (thumb_size - img.width) // 2
            y_offset = y + (thumb_size - img.height) // 2
            montage.paste(img, (x_offset, y_offset))

            # Parse filename for label (e.g., "143506_e1s_L37_C22_R27_forward.jpg")
            parts = snap_path.stem.split('_')
            if len(parts) >= 6:
                time_str = parts[0]
                elapsed = parts[1]
                decision = parts[-1]
                label = f"{time_str[:2]}:{time_str[2:4]}:{time_str[4:]} {elapsed} {decision}"
            else:
                label = snap_path.stem[:30]

            # Draw label below image
            draw.text((x + 5, y + thumb_size + 5), label, fill='white', font=font)

        except Exception as e:
            print(f"Error processing {snap_path}: {e}")
            draw.text((x + 5, y + thumb_size // 2), f"Error: {snap_path.name}", fill='red', font=font)

    return montage


def montage_to_base64(montage: Image.Image, format: str = "JPEG") -> str:
    """Convert montage to base64 string for Claude."""
    buffer = io.BytesIO()
    montage.save(buffer, format=format, quality=85)
    return base64.b64encode(buffer.getvalue()).decode()


def get_journey_montage(count: int = 6) -> dict:
    """Get a montage of recent snapshots as base64."""
    snapshots = get_recent_snapshots(count)
    if not snapshots:
        return {"success": False, "error": "No snapshots found"}

    montage = create_montage(snapshots)
    if montage is None:
        return {"success": False, "error": "Failed to create montage"}

    return {
        "success": True,
        "image_base64": montage_to_base64(montage),
        "snapshot_count": len(snapshots),
        "snapshots": [s.name for s in snapshots],
        "width": montage.width,
        "height": montage.height
    }


def load_nudges() -> dict:
    """Load current nudges from file."""
    if NUDGES_PATH.exists():
        with open(NUDGES_PATH) as f:
            return json.load(f)
    return {"active": False}


def save_nudges(nudges: dict):
    """Save nudges to file (for Claude to update)."""
    with open(NUDGES_PATH, 'w') as f:
        json.dump(nudges, f, indent=2)


def update_nudge(key: str, value):
    """Update a single nudge value."""
    nudges = load_nudges()
    nudges[key] = value
    save_nudges(nudges)
    return nudges


# === Decision Queue ===
# Ring buffer of recent decisions for dashboard visualization

DECISION_QUEUE_PATH = Path(__file__).parent / "decision_queue.json"
MAX_DECISIONS = 20


def load_decision_queue() -> List[dict]:
    """Load recent decisions from file."""
    if DECISION_QUEUE_PATH.exists():
        try:
            with open(DECISION_QUEUE_PATH) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return []
    return []


def save_decision_queue(queue: List[dict]):
    """Save decision queue to file."""
    with open(DECISION_QUEUE_PATH, 'w') as f:
        json.dump(queue[-MAX_DECISIONS:], f)  # Keep only last N


def append_decision(decision: dict):
    """
    Append a decision to the queue.

    Decision format:
    {
        "timestamp_ms": 1234567890,
        "depth": {"left": 40, "center": 35, "right": 60},
        "trace": ["base:FORWARD", "nudge:TURN_LEFT"],
        "final": "TURN_LEFT",
        "committed": false,
        "corner_level": 0
    }
    """
    import time
    queue = load_decision_queue()
    decision["timestamp_ms"] = int(time.time() * 1000)
    queue.append(decision)
    save_decision_queue(queue)


def clear_decision_queue():
    """Clear all decisions from the queue."""
    save_decision_queue([])


if __name__ == "__main__":
    # Test montage generation
    result = get_journey_montage(6)
    if result["success"]:
        print(f"Created montage with {result['snapshot_count']} snapshots")
        print(f"Size: {result['width']}x{result['height']}")

        # Save test montage
        montage_data = base64.b64decode(result["image_base64"])
        with open("test_montage.jpg", "wb") as f:
            f.write(montage_data)
        print("Saved test_montage.jpg")
    else:
        print(f"Error: {result['error']}")
