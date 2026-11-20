import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { DailyStats, SessionPlanPhase } from '../domain/types.js';

interface DailyStatsRow {
  id: string;
  user_id: string;
  date: string;
  sessions_completed: number;
  focus_ms: number;
  tasks_completed: number;
  primordial_completed: number;
  primordial_ignored: number;
  updated_at: number;
}

function mapDailyStats(row: DailyStatsRow): DailyStats {
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    sessionsCompleted: row.sessions_completed,
    focusMs: row.focus_ms,
    tasksCompleted: row.tasks_completed,
    primordialCompleted: row.primordial_completed,
    primordialIgnored: row.primordial_ignored,
    updatedAt: row.updated_at,
  };
}

export interface RecordCompletedSessionInput {
  userId: string;
  sessionId: string;
  plan: SessionPlanPhase[];
  reachedIndex: number;
  endedAt: number;
  skippedFinal: boolean;
  nowMs: number;
}

/**
 * Persists completed/executed cycle records and aggregates daily_stats
 * using precompiled SQLite statements.
 */
export class StatsRepository {
  private readonly stmtInsertCycle: Database.Statement<
    [string, string, string, number, string, number, number, number, number | null, number]
  >;
  private readonly stmtUpsertDailyStats: Database.Statement<
    [string, string, string, number, number, number]
  >;
  private readonly stmtGetDailyStats: Database.Statement<[string, string], DailyStatsRow>;
  private readonly stmtCountCyclesBySession: Database.Statement<[string], { count: number }>;

  constructor(private readonly db: AppDatabase) {
    this.stmtInsertCycle = this.db.prepare(
      `INSERT INTO cycles (
         id, session_id, user_id, cycle_index, phase_type,
         planned_duration_ms, started_at, ends_at, completed_at, skipped
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtUpsertDailyStats = this.db.prepare(
      `INSERT INTO daily_stats (
         id, user_id, date, sessions_completed, focus_ms,
         tasks_completed, primordial_completed, primordial_ignored, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         sessions_completed = daily_stats.sessions_completed + excluded.sessions_completed,
         focus_ms = daily_stats.focus_ms + excluded.focus_ms,
         updated_at = excluded.updated_at`
    );
    this.stmtGetDailyStats = this.db.prepare(
      `SELECT id, user_id, date, sessions_completed, focus_ms,
              tasks_completed, primordial_completed, primordial_ignored, updated_at
       FROM daily_stats WHERE user_id = ? AND date = ?`
    );
    this.stmtCountCyclesBySession = this.db.prepare(
      'SELECT COUNT(*) AS count FROM cycles WHERE session_id = ?'
    );
  }

  recordCompletedSession(input: RecordCompletedSessionInput): { focusMs: number; cyclesRecorded: number } {
    if (input.plan.length === 0) {
      return { focusMs: 0, cyclesRecorded: 0 };
    }

    const existingCount = this.stmtCountCyclesBySession.get(input.sessionId)?.count ?? 0;
    if (existingCount > 0) {
      return { focusMs: 0, cyclesRecorded: 0 };
    }

    const lastIdx = Math.min(input.reachedIndex, input.plan.length - 1);
    let totalFocusMs = 0;
    let cyclesRecorded = 0;

    for (let i = 0; i <= lastIdx; i++) {
      const phase = input.plan[i];
      if (!phase) continue;

      const isLastReached = i === lastIdx;
      const isSkipped = isLastReached && input.skippedFinal;
      const effectiveEnd = Math.min(input.endedAt, phase.endsAt);
      const elapsedMs = Math.max(0, effectiveEnd - phase.startsAt);

      if (phase.phaseType === 'focus' && !isSkipped) {
        totalFocusMs += elapsedMs;
      }

      this.stmtInsertCycle.run(
        crypto.randomUUID(),
        input.sessionId,
        input.userId,
        phase.index,
        phase.phaseType,
        phase.durationMs,
        phase.startsAt,
        phase.endsAt,
        isSkipped ? null : effectiveEnd,
        isSkipped ? 1 : 0
      );
      cyclesRecorded++;
    }

    const dateStr = new Date(input.endedAt).toISOString().slice(0, 10);
    this.stmtUpsertDailyStats.run(
      crypto.randomUUID(),
      input.userId,
      dateStr,
      1,
      totalFocusMs,
      input.nowMs
    );

    return { focusMs: totalFocusMs, cyclesRecorded };
  }

  getDailyStats(userId: string, date: string): DailyStats | null {
    const row = this.stmtGetDailyStats.get(userId, date);
    return row ? mapDailyStats(row) : null;
  }
}
