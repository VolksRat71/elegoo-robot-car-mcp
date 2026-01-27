import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Waypoint {
  id: number;
  name: string;
  x: number;
  y: number;
  heading: number;
  createdAt: string;
}

export interface ScanReading {
  id: number;
  angle: number;
  distance: number;
  x: number;
  y: number;
  timestamp: string;
}

export interface Position {
  x: number;
  y: number;
  heading: number;
}

export interface OccupancyCell {
  x: number;
  y: number;
  occupied: boolean;
  confidence: number;
}

export class MapStore {
  private db: Database.Database;
  private currentPosition: Position = { x: 0, y: 0, heading: 0 };

  constructor(dbPath?: string) {
    const defaultPath = path.join(__dirname, "..", "data", "robot-map.db");
    this.db = new Database(dbPath || defaultPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS waypoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        heading REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scan_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        angle REAL NOT NULL,
        distance REAL NOT NULL,
        robot_x REAL NOT NULL,
        robot_y REAL NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS occupancy_grid (
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        occupied INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.5,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (x, y)
      );

      CREATE TABLE IF NOT EXISTS position (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        heading REAL NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO position (id, x, y, heading) VALUES (1, 0, 0, 0);
    `);

    // Load current position
    const pos = this.db.prepare("SELECT x, y, heading FROM position WHERE id = 1").get() as
      | Position
      | undefined;
    if (pos) {
      this.currentPosition = pos;
    }
  }

  // Waypoint methods
  saveWaypoint(name: string, x?: number, y?: number, heading?: number): Waypoint {
    const pos = {
      x: x ?? this.currentPosition.x,
      y: y ?? this.currentPosition.y,
      heading: heading ?? this.currentPosition.heading,
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO waypoints (name, x, y, heading)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(name, pos.x, pos.y, pos.heading);

    return this.getWaypoint(name)!;
  }

  getWaypoint(name: string): Waypoint | undefined {
    const stmt = this.db.prepare(`
      SELECT id, name, x, y, heading, created_at as createdAt
      FROM waypoints WHERE name = ?
    `);
    return stmt.get(name) as Waypoint | undefined;
  }

  listWaypoints(): Waypoint[] {
    const stmt = this.db.prepare(`
      SELECT id, name, x, y, heading, created_at as createdAt
      FROM waypoints ORDER BY created_at DESC
    `);
    return stmt.all() as Waypoint[];
  }

  deleteWaypoint(name: string): boolean {
    const stmt = this.db.prepare("DELETE FROM waypoints WHERE name = ?");
    const result = stmt.run(name);
    return result.changes > 0;
  }

  // Scan reading methods
  addScanReading(angle: number, distance: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO scan_readings (angle, distance, robot_x, robot_y)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(angle, distance, this.currentPosition.x, this.currentPosition.y);

    // Update occupancy grid based on reading
    this.updateOccupancyFromReading(angle, distance);
  }

  addScanReadings(readings: Array<{ angle: number; distance: number }>): void {
    const insert = this.db.prepare(`
      INSERT INTO scan_readings (angle, distance, robot_x, robot_y)
      VALUES (?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items: typeof readings) => {
      for (const r of items) {
        insert.run(r.angle, r.distance, this.currentPosition.x, this.currentPosition.y);
        this.updateOccupancyFromReading(r.angle, r.distance);
      }
    });

    insertMany(readings);
  }

  private updateOccupancyFromReading(angle: number, distance: number): void {
    // Convert polar to cartesian (relative to robot position)
    const radians = ((this.currentPosition.heading + angle - 90) * Math.PI) / 180;
    const obstacleX = this.currentPosition.x + distance * Math.cos(radians);
    const obstacleY = this.currentPosition.y + distance * Math.sin(radians);

    // Grid cell size in cm
    const cellSize = 10;
    const gridX = Math.round(obstacleX / cellSize);
    const gridY = Math.round(obstacleY / cellSize);

    // Mark cells along the ray as free, endpoint as occupied
    const steps = Math.ceil(distance / cellSize);
    for (let i = 0; i < steps; i++) {
      const ratio = i / steps;
      const cx = Math.round(
        (this.currentPosition.x + ratio * (obstacleX - this.currentPosition.x)) / cellSize
      );
      const cy = Math.round(
        (this.currentPosition.y + ratio * (obstacleY - this.currentPosition.y)) / cellSize
      );
      this.updateCell(cx, cy, false, 0.3);
    }

    // Mark obstacle cell
    if (distance < 400) {
      // Only mark if within sensor range
      this.updateCell(gridX, gridY, true, 0.7);
    }
  }

  private updateCell(x: number, y: number, occupied: boolean, weight: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO occupancy_grid (x, y, occupied, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(x, y) DO UPDATE SET
        occupied = CASE
          WHEN ? = 1 THEN MIN(1.0, confidence + ?)
          ELSE MAX(0.0, confidence - ?)
        END,
        confidence = CASE
          WHEN ? = 1 THEN MIN(1.0, confidence + ?)
          ELSE MAX(0.0, confidence - ?)
        END,
        updated_at = CURRENT_TIMESTAMP
    `);
    const occVal = occupied ? 1 : 0;
    stmt.run(x, y, occVal, 0.5, occVal, weight, weight, occVal, weight, weight);
  }

  // Position methods
  updatePosition(x: number, y: number, heading: number): void {
    this.currentPosition = { x, y, heading };
    const stmt = this.db.prepare(`
      UPDATE position SET x = ?, y = ?, heading = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `);
    stmt.run(x, y, heading);
  }

  getPosition(): Position {
    return { ...this.currentPosition };
  }

  // Estimate position change from movement
  estimateMovement(direction: string, speed: number, durationMs: number): void {
    // Rough estimation: at speed 100, robot moves ~30cm/s
    const distanceCm = (speed / 100) * 30 * (durationMs / 1000);

    let dx = 0,
      dy = 0,
      dHeading = 0;

    switch (direction) {
      case "forward":
        dx = distanceCm * Math.cos((this.currentPosition.heading * Math.PI) / 180);
        dy = distanceCm * Math.sin((this.currentPosition.heading * Math.PI) / 180);
        break;
      case "backward":
        dx = -distanceCm * Math.cos((this.currentPosition.heading * Math.PI) / 180);
        dy = -distanceCm * Math.sin((this.currentPosition.heading * Math.PI) / 180);
        break;
      case "left":
        dHeading = -(speed / 100) * 90 * (durationMs / 1000);
        break;
      case "right":
        dHeading = (speed / 100) * 90 * (durationMs / 1000);
        break;
    }

    this.updatePosition(
      this.currentPosition.x + dx,
      this.currentPosition.y + dy,
      (this.currentPosition.heading + dHeading + 360) % 360
    );
  }

  // Occupancy grid methods
  getOccupancyGrid(minX: number, maxX: number, minY: number, maxY: number): OccupancyCell[] {
    const stmt = this.db.prepare(`
      SELECT x, y, occupied, confidence
      FROM occupancy_grid
      WHERE x >= ? AND x <= ? AND y >= ? AND y <= ?
    `);
    return stmt.all(minX, maxX, minY, maxY) as OccupancyCell[];
  }

  isPathClear(fromX: number, fromY: number, toX: number, toY: number): boolean {
    const cellSize = 10;
    const x1 = Math.round(fromX / cellSize);
    const y1 = Math.round(fromY / cellSize);
    const x2 = Math.round(toX / cellSize);
    const y2 = Math.round(toY / cellSize);

    // Bresenham's line algorithm to check cells along path
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1,
      y = y1;

    while (true) {
      const cell = this.db
        .prepare("SELECT confidence FROM occupancy_grid WHERE x = ? AND y = ?")
        .get(x, y) as { confidence: number } | undefined;

      if (cell && cell.confidence > 0.6) {
        return false; // Obstacle detected
      }

      if (x === x2 && y === y2) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }

    return true;
  }

  clearMap(): void {
    this.db.exec("DELETE FROM scan_readings");
    this.db.exec("DELETE FROM occupancy_grid");
    this.updatePosition(0, 0, 0);
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let mapStoreInstance: MapStore | null = null;

export function getMapStore(): MapStore {
  if (!mapStoreInstance) {
    mapStoreInstance = new MapStore();
  }
  return mapStoreInstance;
}
