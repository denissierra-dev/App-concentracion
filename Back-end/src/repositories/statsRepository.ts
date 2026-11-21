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
  pausedAt?: number | null;
  skippedFinal: boolean;
  nowMs: number;
}

export interface DailyTotals {
  sessionsCompleted: number;
  focusMs: number;
  tasksCompleted: number;
  primordialCompleted: number;
  primordialIgnored: number;
}

export interface CompletedFocusCycleSample {
  startedAt: number;
  endsAt: number;
  completedAt: number;
  plannedDurationMs: number;
}

/**
 * Computes actual active focus time for a cycle, excluding paused intervals
 * reflected in the shifted `endsAt` deadline.
 */
export function computeActiveCycleFocusMs(
  startedAt: number,
  endsAt: number,
  effectiveEnd: number,
  plannedDurationMs: number
): number {
  const rawSpanMs = Math.max(0, effectiveEnd - startedAt);
  const remainingMs = Math.max(0, endsAt - effectiveEnd);
  const activeMs = Math.max(0, plannedDurationMs - remainingMs);
  return Math.min(plannedDurationMs, rawSpanMs, activeMs);
}

export interface LiveTaskStats {
  pendingCount: number;
  primordialIgnoredLive: number;
  primordialActivePending: number;
}

interface DailyTotalsRow {
  sessions_completed: number | null;
  focus_ms: number | null;
  tasks_completed: number | null;
  primordial_completed: number | null;
  primordial_ignored: number | null;
}

interface FocusCycleSampleRow {
  started_at: number;
  ends_at: number;
  completed_at: number;
  planned_duration_ms: number;
}

interface LiveTaskStatsRow {
  pending_count: number | null;
  primordial_ignored_live: number | null;
  primordial_active_pending: number | null;
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
  private readonly stmtListDailyStatsByUser: Database.Statement<[string], DailyStatsRow>;
  private readonly stmtGetDailyTotalsByUser: Database.Statement<[string], DailyTotalsRow>;
  private readonly stmtCountCyclesBySession: Database.Statement<[string], { count: number }>;
  private readonly stmtCountCompletedFocusCycles: Database.Statement<[string], { count: number }>;
  private readonly stmtListFocusCyclesSince: Database.Statement<
    [string, number],
    FocusCycleSampleRow
  >;
  private readonly stmtListCompletedTasksSince: Database.Statement<
    [string, number],
    { completed_at: number }
  >;
  private readonly stmtGetLiveTaskStats: Database.Statement<
    [number, number, string],
    LiveTaskStatsRow
  >;
  private readonly stmtAdjustTasksCompleted: Database.Statement<[string, string, string, number, number, number]>;
  private readonly stmtAdjustPrimordialCompleted: Database.Statement<
    [string, string, string, number, number, number]
  >;
  private readonly stmtAdjustPrimordialIgnored: Database.Statement<
    [string, string, string, number, number, number]
  >;

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
    this.stmtListDailyStatsByUser = this.db.prepare(
      `SELECT id, user_id, date, sessions_completed, focus_ms,
              tasks_completed, primordial_completed, primordial_ignored, updated_at
       FROM daily_stats
       WHERE user_id = ?
       ORDER BY date ASC`
    );
    this.stmtGetDailyTotalsByUser = this.db.prepare(
      `SELECT SUM(sessions_completed) AS sessions_completed,
              SUM(focus_ms) AS focus_ms,
              SUM(tasks_completed) AS tasks_completed,
              SUM(primordial_completed) AS primordial_completed,
              SUM(primordial_ignored) AS primordial_ignored
       FROM daily_stats
       WHERE user_id = ?`
    );
    this.stmtCountCyclesBySession = this.db.prepare(
      'SELECT COUNT(*) AS count FROM cycles WHERE session_id = ?'
    );
    this.stmtCountCompletedFocusCycles = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM cycles
       WHERE user_id = ? AND phase_type = 'focus' AND skipped = 0 AND completed_at IS NOT NULL`
    );
    this.stmtListFocusCyclesSince = this.db.prepare(
      `SELECT started_at, ends_at, completed_at, planned_duration_ms
       FROM cycles
       WHERE user_id = ?
         AND phase_type = 'focus'
         AND skipped = 0
         AND completed_at IS NOT NULL
         AND completed_at >= ?`
    );
    this.stmtListCompletedTasksSince = this.db.prepare(
      `SELECT completed_at
       FROM tasks
       WHERE user_id = ?
         AND completed = 1
         AND completed_at IS NOT NULL
         AND completed_at >= ?`
    );
    this.stmtGetLiveTaskStats = this.db.prepare(
      `SELECT
         SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) AS pending_count,
         SUM(
           CASE
             WHEN completed = 0 AND (
               priority_dismiss_count > 0 OR
               (due_at IS NOT NULL AND due_at < ? AND effective_priority IN ('HIGH', 'CRITICAL'))
             ) THEN 1
             ELSE 0
           END
         ) AS primordial_ignored_live,
         SUM(
           CASE
             WHEN completed = 0
               AND priority_dismiss_count = 0
               AND (due_at IS NULL OR due_at >= ?)
               AND effective_priority IN ('HIGH', 'CRITICAL')
             THEN 1
             ELSE 0
           END
         ) AS primordial_active_pending
       FROM tasks
       WHERE user_id = ?`
    );
    this.stmtAdjustTasksCompleted = this.db.prepare(
      `INSERT INTO daily_stats (
         id, user_id, date, sessions_completed, focus_ms,
         tasks_completed, primordial_completed, primordial_ignored, updated_at
       ) VALUES (?, ?, ?, 0, 0, ?, 0, 0, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         tasks_completed = MAX(0, daily_stats.tasks_completed + ?),
         updated_at = excluded.updated_at`
    );
    this.stmtAdjustPrimordialCompleted = this.db.prepare(
      `INSERT INTO daily_stats (
         id, user_id, date, sessions_completed, focus_ms,
         tasks_completed, primordial_completed, primordial_ignored, updated_at
       ) VALUES (?, ?, ?, 0, 0, 0, ?, 0, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         primordial_completed = MAX(0, daily_stats.primordial_completed + ?),
         updated_at = excluded.updated_at`
    );
    this.stmtAdjustPrimordialIgnored = this.db.prepare(
      `INSERT INTO daily_stats (
         id, user_id, date, sessions_completed, focus_ms,
         tasks_completed, primordial_completed, primordial_ignored, updated_at
       ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         primordial_ignored = MAX(0, daily_stats.primordial_ignored + ?),
         updated_at = excluded.updated_at`
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
      const isSkipped = Boolean(phase.skipped) || (isLastReached && input.skippedFinal);
      const rawPhaseEnd = Math.min(input.endedAt, phase.endsAt);
      const effectiveEnd =
        isLastReached && input.pausedAt !== undefined && input.pausedAt !== null
          ? Math.min(rawPhaseEnd, input.pausedAt)
          : rawPhaseEnd;
      const elapsedMs = computeActiveCycleFocusMs(
        phase.startsAt,
        phase.endsAt,
        effectiveEnd,
        phase.durationMs
      );

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

  adjustTasksCompleted(
    userId: string,
    delta: 1 | -1,
    statTimeMs: number = Date.now(),
    updatedAtMs: number = statTimeMs
  ): void {
    const dateStr = new Date(statTimeMs).toISOString().slice(0, 10);
    const initialValue = delta > 0 ? delta : 0;
    this.stmtAdjustTasksCompleted.run(
      crypto.randomUUID(),
      userId,
      dateStr,
      initialValue,
      updatedAtMs,
      delta
    );
  }

  adjustPrimordialCompleted(
    userId: string,
    delta: 1 | -1,
    statTimeMs: number = Date.now(),
    updatedAtMs: number = statTimeMs
  ): void {
    const dateStr = new Date(statTimeMs).toISOString().slice(0, 10);
    const initialValue = delta > 0 ? delta : 0;
    this.stmtAdjustPrimordialCompleted.run(
      crypto.randomUUID(),
      userId,
      dateStr,
      initialValue,
      updatedAtMs,
      delta
    );
  }

  adjustPrimordialIgnored(userId: string, delta: 1 | -1, nowMs: number = Date.now()): void {
    const dateStr = new Date(nowMs).toISOString().slice(0, 10);
    const initialValue = delta > 0 ? delta : 0;
    this.stmtAdjustPrimordialIgnored.run(
      crypto.randomUUID(),
      userId,
      dateStr,
      initialValue,
      nowMs,
      delta
    );
  }

  listDailyStatsByUser(userId: string): DailyStats[] {
    return this.stmtListDailyStatsByUser.all(userId).map(mapDailyStats);
  }

  getDailyTotalsByUser(userId: string): DailyTotals {
    const row = this.stmtGetDailyTotalsByUser.get(userId);
    return {
      sessionsCompleted: row?.sessions_completed ?? 0,
      focusMs: row?.focus_ms ?? 0,
      tasksCompleted: row?.tasks_completed ?? 0,
      primordialCompleted: row?.primordial_completed ?? 0,
      primordialIgnored: row?.primordial_ignored ?? 0,
    };
  }

  countCompletedFocusCycles(userId: string): number {
    return this.stmtCountCompletedFocusCycles.get(userId)?.count ?? 0;
  }

  listCompletedFocusCyclesSince(userId: string, sinceMs: number): CompletedFocusCycleSample[] {
    return this.stmtListFocusCyclesSince.all(userId, sinceMs).map((row) => ({
      startedAt: row.started_at,
      endsAt: row.ends_at,
      completedAt: row.completed_at,
      plannedDurationMs: row.planned_duration_ms,
    }));
  }

  listCompletedTasksSince(userId: string, sinceMs: number): number[] {
    return this.stmtListCompletedTasksSince.all(userId, sinceMs).map((row) => row.completed_at);
  }

  getLiveTaskStats(userId: string, nowMs: number): LiveTaskStats {
    const row = this.stmtGetLiveTaskStats.get(nowMs, nowMs, userId);
    return {
      pendingCount: row?.pending_count ?? 0,
      primordialIgnoredLive: row?.primordial_ignored_live ?? 0,
      primordialActivePending: row?.primordial_active_pending ?? 0,
    };
  }
}
