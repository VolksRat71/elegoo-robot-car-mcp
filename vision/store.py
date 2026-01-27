"""
Robot State Store - SQLite database for waypoints, sessions, and position.

Python owns the robot, so Python owns the state.
The MCP server calls these endpoints instead of maintaining its own database.
"""

import sqlite3
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, List
from datetime import datetime

DB_PATH = Path(__file__).parent / "robot.db"


@dataclass
class Waypoint:
    """A named location the robot can navigate to."""
    id: int
    name: str
    x: float
    y: float
    heading: float
    created_at: str


@dataclass
class Session:
    """A single autonomous driving session."""
    id: int
    started_at: str
    ended_at: Optional[str]
    duration_s: float
    distance_cm: float
    cells_visited: int
    decisions: int
    goal: Optional[str]


@dataclass
class Position:
    """Current robot position estimate."""
    x: float
    y: float
    heading: float


class RobotStore:
    """
    SQLite store for robot state.

    Tables:
    - waypoints: Named locations for navigation
    - sessions: Autonomous driving session history
    - occupancy_grid: Grid-based map of obstacles
    - position: Current robot position estimate
    """

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.db = sqlite3.connect(str(db_path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init_tables()

    def _init_tables(self):
        """Initialize database schema."""
        self.db.executescript('''
            -- Named waypoints for navigation
            CREATE TABLE IF NOT EXISTS waypoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                heading REAL NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Autonomous driving session history
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT DEFAULT CURRENT_TIMESTAMP,
                ended_at TEXT,
                duration_s REAL DEFAULT 0,
                distance_cm REAL DEFAULT 0,
                cells_visited INTEGER DEFAULT 0,
                decisions INTEGER DEFAULT 0,
                goal TEXT
            );

            -- Grid-based occupancy map (10cm cells)
            CREATE TABLE IF NOT EXISTS occupancy_grid (
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                occupied INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0.5,
                last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (x, y)
            );

            -- Current robot position (singleton row)
            CREATE TABLE IF NOT EXISTS position (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                x REAL DEFAULT 0,
                y REAL DEFAULT 0,
                heading REAL DEFAULT 0,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Ensure position row exists
            INSERT OR IGNORE INTO position (id, x, y, heading) VALUES (1, 0, 0, 0);
        ''')
        self.db.commit()

    # =========================================================================
    # Waypoint Methods
    # =========================================================================

    def save_waypoint(self, name: str, x: float = None, y: float = None,
                      heading: float = None) -> Waypoint:
        """
        Save current position as a named waypoint.
        If x/y/heading not provided, uses current position.
        """
        if x is None or y is None or heading is None:
            pos = self.get_position()
            x = x if x is not None else pos.x
            y = y if y is not None else pos.y
            heading = heading if heading is not None else pos.heading

        self.db.execute('''
            INSERT OR REPLACE INTO waypoints (name, x, y, heading, created_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ''', (name, x, y, heading))
        self.db.commit()
        return self.get_waypoint(name)

    def get_waypoint(self, name: str) -> Optional[Waypoint]:
        """Get a waypoint by name."""
        row = self.db.execute(
            'SELECT id, name, x, y, heading, created_at FROM waypoints WHERE name = ?',
            (name,)
        ).fetchone()
        if row:
            return Waypoint(
                id=row['id'],
                name=row['name'],
                x=row['x'],
                y=row['y'],
                heading=row['heading'],
                created_at=row['created_at']
            )
        return None

    def list_waypoints(self) -> List[Waypoint]:
        """List all waypoints, newest first."""
        rows = self.db.execute(
            'SELECT id, name, x, y, heading, created_at FROM waypoints ORDER BY created_at DESC'
        ).fetchall()
        return [Waypoint(
            id=r['id'],
            name=r['name'],
            x=r['x'],
            y=r['y'],
            heading=r['heading'],
            created_at=r['created_at']
        ) for r in rows]

    def delete_waypoint(self, name: str) -> bool:
        """Delete a waypoint by name. Returns True if deleted."""
        cursor = self.db.execute('DELETE FROM waypoints WHERE name = ?', (name,))
        self.db.commit()
        return cursor.rowcount > 0

    # =========================================================================
    # Session Methods
    # =========================================================================

    def start_session(self, goal: str = None) -> int:
        """Start a new driving session. Returns session ID."""
        cursor = self.db.execute(
            'INSERT INTO sessions (goal) VALUES (?)',
            (goal,)
        )
        self.db.commit()
        return cursor.lastrowid

    def end_session(self, session_id: int, duration_s: float, distance_cm: float,
                    cells_visited: int, decisions: int):
        """End a driving session with final stats."""
        self.db.execute('''
            UPDATE sessions
            SET ended_at = CURRENT_TIMESTAMP,
                duration_s = ?,
                distance_cm = ?,
                cells_visited = ?,
                decisions = ?
            WHERE id = ?
        ''', (duration_s, distance_cm, cells_visited, decisions, session_id))
        self.db.commit()

    def get_session(self, session_id: int) -> Optional[Session]:
        """Get a session by ID."""
        row = self.db.execute(
            'SELECT * FROM sessions WHERE id = ?',
            (session_id,)
        ).fetchone()
        if row:
            return Session(
                id=row['id'],
                started_at=row['started_at'],
                ended_at=row['ended_at'],
                duration_s=row['duration_s'] or 0,
                distance_cm=row['distance_cm'] or 0,
                cells_visited=row['cells_visited'] or 0,
                decisions=row['decisions'] or 0,
                goal=row['goal']
            )
        return None

    def get_recent_sessions(self, limit: int = 10) -> List[Session]:
        """Get recent sessions, newest first."""
        rows = self.db.execute(
            'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?',
            (limit,)
        ).fetchall()
        return [Session(
            id=r['id'],
            started_at=r['started_at'],
            ended_at=r['ended_at'],
            duration_s=r['duration_s'] or 0,
            distance_cm=r['distance_cm'] or 0,
            cells_visited=r['cells_visited'] or 0,
            decisions=r['decisions'] or 0,
            goal=r['goal']
        ) for r in rows]

    # =========================================================================
    # Position Methods
    # =========================================================================

    def get_position(self) -> Position:
        """Get current robot position estimate."""
        row = self.db.execute(
            'SELECT x, y, heading FROM position WHERE id = 1'
        ).fetchone()
        return Position(x=row['x'], y=row['y'], heading=row['heading'])

    def set_position(self, x: float, y: float, heading: float):
        """Update robot position estimate."""
        self.db.execute('''
            UPDATE position
            SET x = ?, y = ?, heading = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        ''', (x, y, heading))
        self.db.commit()

    def reset_position(self):
        """Reset position to origin."""
        self.set_position(0, 0, 0)

    def update_position_from_movement(self, direction: str, speed: int,
                                       duration_ms: int) -> Position:
        """
        Estimate position change from a movement command.
        Uses dead reckoning - accuracy degrades over time.
        """
        import math

        pos = self.get_position()

        # Rough estimation: at speed 100, robot moves ~30cm/s
        distance_cm = (speed / 100) * 30 * (duration_ms / 1000)

        if direction == "forward":
            rad = math.radians(pos.heading)
            new_x = pos.x + distance_cm * math.sin(rad)
            new_y = pos.y + distance_cm * math.cos(rad)
            self.set_position(new_x, new_y, pos.heading)
        elif direction == "backward":
            rad = math.radians(pos.heading)
            new_x = pos.x - distance_cm * math.sin(rad)
            new_y = pos.y - distance_cm * math.cos(rad)
            self.set_position(new_x, new_y, pos.heading)
        elif direction == "left":
            # Turning: estimate ~90 deg/s at speed 100
            turn_deg = (speed / 100) * 90 * (duration_ms / 1000)
            new_heading = (pos.heading - turn_deg) % 360
            self.set_position(pos.x, pos.y, new_heading)
        elif direction == "right":
            turn_deg = (speed / 100) * 90 * (duration_ms / 1000)
            new_heading = (pos.heading + turn_deg) % 360
            self.set_position(pos.x, pos.y, new_heading)

        return self.get_position()

    # =========================================================================
    # Occupancy Grid Methods
    # =========================================================================

    def update_cell(self, x: int, y: int, occupied: bool, confidence_delta: float = 0.1):
        """Update a grid cell's occupancy belief."""
        if occupied:
            self.db.execute('''
                INSERT INTO occupancy_grid (x, y, occupied, confidence, last_seen)
                VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(x, y) DO UPDATE SET
                    occupied = 1,
                    confidence = MIN(1.0, confidence + ?),
                    last_seen = CURRENT_TIMESTAMP
            ''', (x, y, 0.5 + confidence_delta, confidence_delta))
        else:
            self.db.execute('''
                INSERT INTO occupancy_grid (x, y, occupied, confidence, last_seen)
                VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(x, y) DO UPDATE SET
                    confidence = MAX(0.0, confidence - ?),
                    last_seen = CURRENT_TIMESTAMP
            ''', (x, y, 0.5 - confidence_delta, confidence_delta))
        self.db.commit()

    def get_cell(self, x: int, y: int) -> Optional[dict]:
        """Get a grid cell's state."""
        row = self.db.execute(
            'SELECT occupied, confidence, last_seen FROM occupancy_grid WHERE x = ? AND y = ?',
            (x, y)
        ).fetchone()
        if row:
            return {
                'x': x,
                'y': y,
                'occupied': bool(row['occupied']),
                'confidence': row['confidence'],
                'last_seen': row['last_seen']
            }
        return None

    def get_grid_region(self, min_x: int, max_x: int, min_y: int, max_y: int) -> List[dict]:
        """Get all cells in a region."""
        rows = self.db.execute('''
            SELECT x, y, occupied, confidence, last_seen
            FROM occupancy_grid
            WHERE x >= ? AND x <= ? AND y >= ? AND y <= ?
        ''', (min_x, max_x, min_y, max_y)).fetchall()
        return [{
            'x': r['x'],
            'y': r['y'],
            'occupied': bool(r['occupied']),
            'confidence': r['confidence'],
            'last_seen': r['last_seen']
        } for r in rows]

    def clear_grid(self):
        """Clear the occupancy grid."""
        self.db.execute('DELETE FROM occupancy_grid')
        self.db.commit()

    def clear_all(self):
        """Clear all data and reset position."""
        self.db.execute('DELETE FROM occupancy_grid')
        self.db.execute('DELETE FROM sessions')
        self.reset_position()
        self.db.commit()

    # =========================================================================
    # Utility
    # =========================================================================

    def close(self):
        """Close database connection."""
        self.db.close()

    def get_stats(self) -> dict:
        """Get database statistics."""
        waypoint_count = self.db.execute('SELECT COUNT(*) FROM waypoints').fetchone()[0]
        session_count = self.db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        cell_count = self.db.execute('SELECT COUNT(*) FROM occupancy_grid').fetchone()[0]
        pos = self.get_position()

        return {
            'waypoints': waypoint_count,
            'sessions': session_count,
            'grid_cells': cell_count,
            'position': {'x': pos.x, 'y': pos.y, 'heading': pos.heading},
            'db_path': str(self.db_path)
        }


# =============================================================================
# Singleton Access
# =============================================================================

_store: Optional[RobotStore] = None


def get_store() -> RobotStore:
    """Get the singleton RobotStore instance."""
    global _store
    if _store is None:
        _store = RobotStore()
    return _store


if __name__ == "__main__":
    # Test the store
    store = get_store()
    print(f"Store stats: {store.get_stats()}")

    # Test waypoint
    wp = store.save_waypoint("test_point", 100, 200, 45)
    print(f"Saved waypoint: {wp}")

    # Test position
    pos = store.get_position()
    print(f"Current position: {pos}")

    # List waypoints
    waypoints = store.list_waypoints()
    print(f"All waypoints: {waypoints}")
