import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { Session, SessionPlanPhase, SessionStatus } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';

interface SessionRow {
  id: string;
  user_id: string;
  status: string;
  plan_json: string;
  current_index: number;
  started_at: number;
  accumulated_pause_ms: number;
  paused_at: number | null;
  ended_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as SessionStatus,
    plan: JSON.parse(row.plan_json) as SessionPlanPhase[],
    currentIndex: row.current_index,
    startedAt: row.started_at,
    accumulatedPauseMs: row.accumulated_pause_ms,
    pausedAt: row.paused_at,
    endedAt: row.ended_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionRepository {
  private readonly stmtExistsById: Database.Statement<[string], { found: number }>;
  private readonly stmtFindByIdForUser: Database.Statement<[string, string], SessionRow>;
  private readonly stmtFindCurrentByUser: Database.Statement<[string], SessionRow>;
  private readonly stmtInsert: Database.Statement<
    [
      string,
      string,
      string,
      string,
      number,
      number,
      number,
      number | null,
      number | null,
      number,
      number,
      number,
    ]
  >;
  private readonly stmtUpdate: Database.Statement<
    [
      string,
      string,
      number,
      number,
      number | null,
      number | null,
      number,
      number,
      string,
      string,
      number,
    ]
  >;

  constructor(private readonly db: AppDatabase) {
    this.stmtExistsById = this.db.prepare('SELECT 1 AS found FROM sessions WHERE id = ? LIMIT 1');
    this.stmtFindByIdForUser = this.db.prepare(
      `SELECT id, user_id, status, plan_json, current_index, started_at,
              accumulated_pause_ms, paused_at, ended_at, version, created_at, updated_at
       FROM sessions WHERE id = ? AND user_id = ?`
    );
    this.stmtFindCurrentByUser = this.db.prepare(
      `SELECT id, user_id, status, plan_json, current_index, started_at,
              accumulated_pause_ms, paused_at, ended_at, version, created_at, updated_at
       FROM sessions
       WHERE user_id = ? AND status IN ('active', 'paused')
       ORDER BY created_at DESC
       LIMIT 1`
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO sessions (
         id, user_id, status, plan_json, current_index, started_at,
         accumulated_pause_ms, paused_at, ended_at, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE sessions
       SET status = ?,
           plan_json = ?,
           current_index = ?,
           accumulated_pause_ms = ?,
           paused_at = ?,
           ended_at = ?,
           version = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ? AND version = ?`
    );
  }

  existsById(id: string): boolean {
    return this.stmtExistsById.get(id) !== undefined;
  }

  findByIdForUser(id: string, userId: string): Session | null {
    const row = this.stmtFindByIdForUser.get(id, userId);
    return row ? mapSession(row) : null;
  }

  /**
   * Returns the most recent in-progress ('active' or 'paused') session for a user.
   */
  findCurrentByUser(userId: string): Session | null {
    const row = this.stmtFindCurrentByUser.get(userId);
    return row ? mapSession(row) : null;
  }

  create(session: Session): Session {
    this.stmtInsert.run(
      session.id,
      session.userId,
      session.status,
      JSON.stringify(session.plan),
      session.currentIndex,
      session.startedAt,
      session.accumulatedPauseMs,
      session.pausedAt,
      session.endedAt,
      session.version,
      session.createdAt,
      session.updatedAt
    );

    return session;
  }

  update(session: Session, expectedVersion: number = session.version - 1): Session {
    const result = this.stmtUpdate.run(
      session.status,
      JSON.stringify(session.plan),
      session.currentIndex,
      session.accumulatedPauseMs,
      session.pausedAt,
      session.endedAt,
      session.version,
      session.updatedAt,
      session.id,
      session.userId,
      expectedVersion
    );

    if (result.changes === 0) {
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'Session was modified concurrently; please refresh and retry'
      );
    }

    return session;
  }
}
