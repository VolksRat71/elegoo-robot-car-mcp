/**
 * Session Logger
 *
 * Logs WorldState snapshots and actions to SQLite for replay and debugging.
 * Enables iterating on mapping/autonomy without re-driving the robot.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import type { WorldState } from "./world-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Session {
  id: number;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
}

export interface WorldStateLogEntry {
  id: number;
  session_id: number;
  timestamp_ms: number;
  state: WorldState;
}

export interface ActionLogEntry {
  id: number;
  session_id: number;
  timestamp_ms: number;
  action: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
}

export class SessionLogger {
  private db: Database.Database;
  private currentSessionId: number | null = null;

  constructor(dbPath?: string) {
    const defaultPath = path.join(__dirname, "..", "..", "data", "robot-map.db");
    this.db = new Database(dbPath || defaultPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS world_state_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES sessions(id),
        timestamp_ms INTEGER NOT NULL,
        state JSON NOT NULL
      );

      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES sessions(id),
        timestamp_ms INTEGER NOT NULL,
        action TEXT NOT NULL,
        params JSON,
        result JSON
      );

      CREATE INDEX IF NOT EXISTS idx_world_state_session ON world_state_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_world_state_timestamp ON world_state_log(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_action_log_timestamp ON action_log(timestamp_ms);
    `);
  }

  /**
   * Start a new session
   */
  startSession(notes?: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (notes) VALUES (?)
    `);
    const result = stmt.run(notes || null);
    this.currentSessionId = result.lastInsertRowid as number;
    console.error(`[Logger] Started session ${this.currentSessionId}`);
    return this.currentSessionId;
  }

  /**
   * End the current session
   */
  endSession(): void {
    if (this.currentSessionId === null) return;

    const stmt = this.db.prepare(`
      UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(this.currentSessionId);
    console.error(`[Logger] Ended session ${this.currentSessionId}`);
    this.currentSessionId = null;
  }

  /**
   * Get the current session ID, starting one if needed
   */
  ensureSession(): number {
    if (this.currentSessionId === null) {
      return this.startSession("Auto-started session");
    }
    return this.currentSessionId;
  }

  /**
   * Log a WorldState snapshot
   */
  logWorldState(state: WorldState): void {
    const sessionId = this.ensureSession();

    const stmt = this.db.prepare(`
      INSERT INTO world_state_log (session_id, timestamp_ms, state)
      VALUES (?, ?, ?)
    `);
    stmt.run(sessionId, state.timestamp_ms, JSON.stringify(state));
  }

  /**
   * Log an action with parameters and result
   */
  logAction(
    action: string,
    params: Record<string, unknown>,
    result: Record<string, unknown>
  ): void {
    const sessionId = this.ensureSession();

    const stmt = this.db.prepare(`
      INSERT INTO action_log (session_id, timestamp_ms, action, params, result)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      Date.now(),
      action,
      JSON.stringify(params),
      JSON.stringify(result)
    );
  }

  /**
   * Get all sessions
   */
  listSessions(): Session[] {
    const stmt = this.db.prepare(`
      SELECT id, started_at, ended_at, notes FROM sessions ORDER BY started_at DESC
    `);
    return stmt.all() as Session[];
  }

  /**
   * Get a specific session
   */
  getSession(id: number): Session | undefined {
    const stmt = this.db.prepare(`
      SELECT id, started_at, ended_at, notes FROM sessions WHERE id = ?
    `);
    return stmt.get(id) as Session | undefined;
  }

  /**
   * Get WorldState logs for a session
   */
  getWorldStateLogs(sessionId: number, limit?: number): WorldStateLogEntry[] {
    let sql = `
      SELECT id, session_id, timestamp_ms, state
      FROM world_state_log
      WHERE session_id = ?
      ORDER BY timestamp_ms ASC
    `;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId) as Array<{
      id: number;
      session_id: number;
      timestamp_ms: number;
      state: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      timestamp_ms: row.timestamp_ms,
      state: JSON.parse(row.state) as WorldState,
    }));
  }

  /**
   * Get action logs for a session
   */
  getActionLogs(sessionId: number, limit?: number): ActionLogEntry[] {
    let sql = `
      SELECT id, session_id, timestamp_ms, action, params, result
      FROM action_log
      WHERE session_id = ?
      ORDER BY timestamp_ms ASC
    `;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId) as Array<{
      id: number;
      session_id: number;
      timestamp_ms: number;
      action: string;
      params: string;
      result: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      timestamp_ms: row.timestamp_ms,
      action: row.action,
      params: JSON.parse(row.params || "{}") as Record<string, unknown>,
      result: JSON.parse(row.result || "{}") as Record<string, unknown>,
    }));
  }

  /**
   * Export a session as JSONL for replay
   */
  exportSession(sessionId: number): string {
    const worldStates = this.getWorldStateLogs(sessionId);
    const actions = this.getActionLogs(sessionId);

    // Merge and sort by timestamp
    const entries: Array<{
      type: "state" | "action" | "result";
      ts: number;
      data?: WorldState;
      action?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
    }> = [];

    for (const ws of worldStates) {
      entries.push({
        type: "state",
        ts: ws.timestamp_ms,
        data: ws.state,
      });
    }

    for (const act of actions) {
      entries.push({
        type: "action",
        ts: act.timestamp_ms,
        action: act.action,
        params: act.params,
        result: act.result,
      });
    }

    // Sort by timestamp
    entries.sort((a, b) => a.ts - b.ts);

    // Convert to JSONL
    return entries.map((e) => JSON.stringify(e)).join("\n");
  }

  /**
   * Delete a session and all its logs
   */
  deleteSession(sessionId: number): boolean {
    const deleteWorldStates = this.db.prepare(
      "DELETE FROM world_state_log WHERE session_id = ?"
    );
    const deleteActions = this.db.prepare(
      "DELETE FROM action_log WHERE session_id = ?"
    );
    const deleteSession = this.db.prepare("DELETE FROM sessions WHERE id = ?");

    const transaction = this.db.transaction(() => {
      deleteWorldStates.run(sessionId);
      deleteActions.run(sessionId);
      const result = deleteSession.run(sessionId);
      return result.changes > 0;
    });

    return transaction();
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.currentSessionId !== null) {
      this.endSession();
    }
    this.db.close();
  }
}

// Singleton instance
let loggerInstance: SessionLogger | null = null;

export function getSessionLogger(): SessionLogger {
  if (!loggerInstance) {
    loggerInstance = new SessionLogger();
  }
  return loggerInstance;
}
