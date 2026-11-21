import type { DailyStats } from '../domain/types.js';
import {
  computeActiveCycleFocusMs,
  type StatsRepository,
} from '../repositories/statsRepository.js';

export interface StatsServiceDeps {
  statsRepo: StatsRepository;
}

export interface DailyProductivityPoint {
  date: string;
  sessionsCompleted: number;
  focusMs: number;
  focusMinutes: number;
  tasksCompleted: number;
  primordialCompleted: number;
  primordialIgnored: number;
}

export interface WeekdayProductivityPoint {
  weekday: number; // 0 (Sunday) .. 6 (Saturday)
  label: string;
  sessionsCompleted: number;
  focusMs: number;
  tasksCompleted: number;
}

export interface HourlyProductivityPoint {
  hour: number; // 0 .. 23 (UTC)
  focusCycles: number;
  focusMs: number;
  tasksCompleted: number;
}

export interface StatsDashboardResponse {
  today: {
    date: string;
    sessionsCompleted: number;
    focusMs: number;
    focusMinutes: number;
    tasksCompleted: number;
  };
  totals: {
    sessionsCompleted: number;
    focusMs: number;
    focusMinutes: number;
    cyclesCompleted: number;
    tasksCompleted: number;
    tasksPending: number;
  };
  streaks: {
    currentDays: number;
    longestDays: number;
    lastActiveDate: string | null;
  };
  primordial: {
    completedBeforeDeadline: number;
    ignored: number;
    activePending: number;
    completionRate: number | null;
  };
  productivity: {
    windowDays: number;
    byDay: DailyProductivityPoint[];
    byWeekday: WeekdayProductivityPoint[];
    byHour: HourlyProductivityPoint[];
    peakHour: {
      hour: number;
      focusMs: number;
      tasksCompleted: number;
    } | null;
  };
  serverTimeMs: number;
}

export type StatsExportFormat = 'json' | 'csv';

export interface StatsExportResult {
  format: StatsExportFormat;
  contentType: string;
  filename: string;
  body: string;
}

const MS_PER_DAY = 86_400_000;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function toUtcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseUtcDayIndex(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T00:00:00.000Z`) / MS_PER_DAY);
}

function addUtcDays(dateStr: string, deltaDays: number): string {
  const epochMs = parseUtcDayIndex(dateStr) * MS_PER_DAY + deltaDays * MS_PER_DAY;
  return toUtcDateStr(epochMs);
}

function isActiveDay(row: DailyStats): boolean {
  return row.sessionsCompleted > 0 || row.focusMs > 0 || row.tasksCompleted > 0;
}

function computeStreaks(
  dailyRows: DailyStats[],
  todayStr: string
): { currentDays: number; longestDays: number; lastActiveDate: string | null } {
  const activeDates = dailyRows.filter(isActiveDay).map((row) => row.date);
  if (activeDates.length === 0) {
    return { currentDays: 0, longestDays: 0, lastActiveDate: null };
  }

  const activeSet = new Set(activeDates);
  const lastActiveDate = activeDates[activeDates.length - 1] ?? null;

  let longestDays = 1;
  let currentRun = 1;
  for (let i = 1; i < activeDates.length; i++) {
    const prevIdx = parseUtcDayIndex(activeDates[i - 1]!);
    const currIdx = parseUtcDayIndex(activeDates[i]!);
    if (currIdx - prevIdx === 1) {
      currentRun++;
      if (currentRun > longestDays) {
        longestDays = currentRun;
      }
    } else if (currIdx !== prevIdx) {
      currentRun = 1;
    }
  }

  const yesterdayStr = addUtcDays(todayStr, -1);
  let cursor: string | null = activeSet.has(todayStr)
    ? todayStr
    : activeSet.has(yesterdayStr)
      ? yesterdayStr
      : null;

  let currentDays = 0;
  while (cursor !== null && activeSet.has(cursor)) {
    currentDays++;
    cursor = addUtcDays(cursor, -1);
  }

  return { currentDays, longestDays, lastActiveDate };
}

function escapeCsvCell(value: string | number): string {
  const raw = String(value);
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(raw);
  const safe = needsFormulaGuard ? `'${raw}` : raw;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Computes on-demand productivity dashboards, streaks, hourly/daily aggregations,
 * primordial task compliance rates, and JSON/CSV exports.
 */
export class StatsService {
  constructor(private readonly deps: StatsServiceDeps) {}

  getDashboardStats(
    userId: string,
    options?: { days?: number; nowMs?: number }
  ): StatsDashboardResponse {
    const nowMs = options?.nowMs ?? Date.now();
    const windowDays = options?.days ?? 30;
    const todayStr = toUtcDateStr(nowMs);
    const windowStartDateStr = addUtcDays(todayStr, -(windowDays - 1));
    const windowStartMs = parseUtcDayIndex(windowStartDateStr) * MS_PER_DAY;

    const allDailyRows = this.deps.statsRepo.listDailyStatsByUser(userId);
    const dailyByDate = new Map<string, DailyStats>();
    for (const row of allDailyRows) {
      dailyByDate.set(row.date, row);
    }

    const todayRow = dailyByDate.get(todayStr);
    const todayFocusMs = todayRow?.focusMs ?? 0;

    const totalsRow = this.deps.statsRepo.getDailyTotalsByUser(userId);
    const cyclesCompleted = this.deps.statsRepo.countCompletedFocusCycles(userId);
    const liveTaskStats = this.deps.statsRepo.getLiveTaskStats(userId, nowMs);

    const streaks = computeStreaks(allDailyRows, todayStr);

    const primordialCompleted = totalsRow.primordialCompleted;
    const primordialIgnored = totalsRow.primordialIgnored + liveTaskStats.primordialIgnoredLive;
    const primordialTotal = primordialCompleted + primordialIgnored;
    const completionRate =
      primordialTotal > 0 ? Math.round((primordialCompleted / primordialTotal) * 10_000) / 10_000 : null;

    const byDay: DailyProductivityPoint[] = [];
    const byWeekday: WeekdayProductivityPoint[] = WEEKDAY_LABELS.map((label, weekday) => ({
      weekday,
      label,
      sessionsCompleted: 0,
      focusMs: 0,
      tasksCompleted: 0,
    }));

    for (let offset = 0; offset < windowDays; offset++) {
      const dateStr = addUtcDays(windowStartDateStr, offset);
      const row = dailyByDate.get(dateStr);
      const focusMs = row?.focusMs ?? 0;
      const sessionsCompleted = row?.sessionsCompleted ?? 0;
      const tasksCompleted = row?.tasksCompleted ?? 0;

      byDay.push({
        date: dateStr,
        sessionsCompleted,
        focusMs,
        focusMinutes: Math.round(focusMs / 60_000),
        tasksCompleted,
        primordialCompleted: row?.primordialCompleted ?? 0,
        primordialIgnored: row?.primordialIgnored ?? 0,
      });

      const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
      const weekdayBucket = byWeekday[weekday];
      if (weekdayBucket) {
        weekdayBucket.sessionsCompleted += sessionsCompleted;
        weekdayBucket.focusMs += focusMs;
        weekdayBucket.tasksCompleted += tasksCompleted;
      }
    }

    const byHour: HourlyProductivityPoint[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      focusCycles: 0,
      focusMs: 0,
      tasksCompleted: 0,
    }));

    const focusCycles = this.deps.statsRepo.listCompletedFocusCyclesSince(userId, windowStartMs);
    for (const cycle of focusCycles) {
      const hour = new Date(cycle.startedAt).getUTCHours();
      const bucket = byHour[hour];
      if (!bucket) continue;

      const elapsedMs = computeActiveCycleFocusMs(
        cycle.startedAt,
        cycle.endsAt,
        cycle.completedAt,
        cycle.plannedDurationMs
      );
      bucket.focusCycles += 1;
      bucket.focusMs += elapsedMs;
    }

    const completedTaskTimestamps = this.deps.statsRepo.listCompletedTasksSince(
      userId,
      windowStartMs
    );
    for (const completedAt of completedTaskTimestamps) {
      const hour = new Date(completedAt).getUTCHours();
      const bucket = byHour[hour];
      if (bucket) {
        bucket.tasksCompleted += 1;
      }
    }

    let peakHour: StatsDashboardResponse['productivity']['peakHour'] = null;
    for (const bucket of byHour) {
      if (bucket.focusMs === 0 && bucket.tasksCompleted === 0) {
        continue;
      }
      if (
        !peakHour ||
        bucket.focusMs > peakHour.focusMs ||
        (bucket.focusMs === peakHour.focusMs && bucket.tasksCompleted > peakHour.tasksCompleted)
      ) {
        peakHour = {
          hour: bucket.hour,
          focusMs: bucket.focusMs,
          tasksCompleted: bucket.tasksCompleted,
        };
      }
    }

    return {
      today: {
        date: todayStr,
        sessionsCompleted: todayRow?.sessionsCompleted ?? 0,
        focusMs: todayFocusMs,
        focusMinutes: Math.round(todayFocusMs / 60_000),
        tasksCompleted: todayRow?.tasksCompleted ?? 0,
      },
      totals: {
        sessionsCompleted: totalsRow.sessionsCompleted,
        focusMs: totalsRow.focusMs,
        focusMinutes: Math.round(totalsRow.focusMs / 60_000),
        cyclesCompleted,
        tasksCompleted: totalsRow.tasksCompleted,
        tasksPending: liveTaskStats.pendingCount,
      },
      streaks,
      primordial: {
        completedBeforeDeadline: primordialCompleted,
        ignored: primordialIgnored,
        activePending: liveTaskStats.primordialActivePending,
        completionRate,
      },
      productivity: {
        windowDays,
        byDay,
        byWeekday,
        byHour,
        peakHour,
      },
      serverTimeMs: nowMs,
    };
  }

  exportStats(
    userId: string,
    options: { format: StatsExportFormat; days?: number; nowMs?: number }
  ): StatsExportResult {
    const nowMs = options.nowMs ?? Date.now();
    const days = options.days ?? 30;
    const summary = this.getDashboardStats(userId, { days, nowMs });

    if (options.format === 'csv') {
      const header = [
        'date',
        'sessions_completed',
        'focus_ms',
        'focus_minutes',
        'tasks_completed',
        'primordial_completed',
        'primordial_ignored',
      ].join(',');

      const rows = summary.productivity.byDay.map((day) =>
        [
          escapeCsvCell(day.date),
          escapeCsvCell(day.sessionsCompleted),
          escapeCsvCell(day.focusMs),
          escapeCsvCell(day.focusMinutes),
          escapeCsvCell(day.tasksCompleted),
          escapeCsvCell(day.primordialCompleted),
          escapeCsvCell(day.primordialIgnored),
        ].join(',')
      );

      return {
        format: 'csv',
        contentType: 'text/csv; charset=utf-8',
        filename: `deep-work-stats-${days}d.csv`,
        body: [header, ...rows].join('\n'),
      };
    }

    return {
      format: 'json',
      contentType: 'application/json; charset=utf-8',
      filename: `deep-work-stats-${days}d.json`,
      body: JSON.stringify(
        {
          exportedAt: new Date(nowMs).toISOString(),
          windowDays: days,
          summary,
        },
        null,
        2
      ),
    };
  }
}
