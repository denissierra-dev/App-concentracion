import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';

describe('Fase 8: Estadísticas y Analytics (/api/v1/stats)', () => {
  let db: AppDatabase;
  let deviceId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T14:00:00.000Z'));

    db = createDatabase(':memory:');
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    deviceId = reg.body.deviceId;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('requires authentication for /api/v1/stats and /api/v1/stats/export', async () => {
    const app = createApp({ db });

    expect((await request(app).get('/api/v1/stats')).status).toBe(401);
    expect((await request(app).get('/api/v1/stats/export')).status).toBe(401);
  });

  it('returns zeroed on-demand dashboard aggregates for a new user', async () => {
    const app = createApp({ db });

    const res = await request(app)
      .get('/api/v1/stats?days=7')
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.today).toEqual({
      date: '2026-11-20',
      sessionsCompleted: 0,
      focusMs: 0,
      focusMinutes: 0,
      tasksCompleted: 0,
    });
    expect(res.body.totals).toEqual({
      sessionsCompleted: 0,
      focusMs: 0,
      focusMinutes: 0,
      cyclesCompleted: 0,
      tasksCompleted: 0,
      tasksPending: 0,
    });
    expect(res.body.streaks).toEqual({
      currentDays: 0,
      longestDays: 0,
      lastActiveDate: null,
    });
    expect(res.body.primordial).toEqual({
      completedBeforeDeadline: 0,
      ignored: 0,
      activePending: 0,
      completionRate: null,
    });
    expect(res.body.productivity.windowDays).toBe(7);
    expect(res.body.productivity.byDay).toHaveLength(7);
    expect(res.body.productivity.byDay[0].date).toBe('2026-11-14');
    expect(res.body.productivity.byDay[6].date).toBe('2026-11-20');
    expect(res.body.productivity.byWeekday).toHaveLength(7);
    expect(res.body.productivity.byHour).toHaveLength(24);
    expect(res.body.productivity.peakHour).toBeNull();
  });

  it('calculates streaks, today/total metrics, hourly/weekday breakdowns, and isolates users', async () => {
    const app = createApp({ db });

    // Day 1: 2026-11-15 at 09:00 UTC -> complete 25m focus session
    vi.setSystemTime(new Date('2026-11-15T09:00:00.000Z'));
    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    vi.advanceTimersByTime(26 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${s1.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});

    // Day 2: 2026-11-16 at 09:00 UTC -> complete 1 task (2-day streak, then gap on Nov 17)
    vi.setSystemTime(new Date('2026-11-16T09:00:00.000Z'));
    const tGap = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Streak day 2 task' });
    await request(app)
      .patch(`/api/v1/tasks/${tGap.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    // Day 4: 2026-11-18 at 14:00 UTC -> complete 25m focus session
    vi.setSystemTime(new Date('2026-11-18T14:00:00.000Z'));
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    vi.advanceTimersByTime(26 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${s2.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});

    // Day 5: 2026-11-19 at 14:00 UTC -> complete 25m focus session + 1 task
    vi.setSystemTime(new Date('2026-11-19T14:00:00.000Z'));
    const s3 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    vi.advanceTimersByTime(26 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${s3.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});

    const tYesterday = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Yesterday task' });
    await request(app)
      .patch(`/api/v1/tasks/${tYesterday.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    // On 2026-11-20 (before any activity today), streak from Nov 18..19 (2 days) is still active
    vi.setSystemTime(new Date('2026-11-20T08:00:00.000Z'));
    const morningStats = await request(app)
      .get('/api/v1/stats?days=10')
      .set('x-device-id', deviceId);
    expect(morningStats.status).toBe(200);
    expect(morningStats.body.streaks).toEqual({
      currentDays: 2,
      longestDays: 2,
      lastActiveDate: '2026-11-19',
    });

    // Day 6 (today): 2026-11-20 at 14:00 UTC -> 20m focus + 1 pending task
    vi.setSystemTime(new Date('2026-11-20T14:00:00.000Z'));
    const s4 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    vi.advanceTimersByTime(20 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${s4.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});

    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Still pending' });

    // Other user activity must not leak into our stats
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', otherUser.body.deviceId)
      .send({ title: 'Other user task' });

    const res = await request(app)
      .get('/api/v1/stats?days=10')
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.today).toEqual({
      date: '2026-11-20',
      sessionsCompleted: 1,
      focusMs: 20 * 60_000,
      focusMinutes: 20,
      tasksCompleted: 0,
    });
    expect(res.body.totals).toEqual({
      sessionsCompleted: 4,
      focusMs: 95 * 60_000,
      focusMinutes: 95,
      cyclesCompleted: 4,
      tasksCompleted: 2,
      tasksPending: 1,
    });
    expect(res.body.streaks).toEqual({
      currentDays: 3,
      longestDays: 3,
      lastActiveDate: '2026-11-20',
    });

    // Peak hour is 14:00 UTC (Nov 18 25m + Nov 19 25m + Nov 20 20m = 70m, 3 focus cycles, 1 task)
    expect(res.body.productivity.peakHour).toEqual({
      hour: 14,
      focusMs: 70 * 60_000,
      tasksCompleted: 1,
    });
    expect(res.body.productivity.byHour[9]).toEqual({
      hour: 9,
      focusCycles: 1,
      focusMs: 25 * 60_000,
      tasksCompleted: 1,
    });

    // Nov 20 is Friday (weekday 5)
    const fridayBucket = res.body.productivity.byWeekday[5];
    expect(fridayBucket.label).toBe('Fri');
    expect(fridayBucket.sessionsCompleted).toBe(1);
    expect(fridayBucket.focusMs).toBe(20 * 60_000);
  });

  it('tracks primordial task compliance rate (completed before deadline vs ignored/overdue)', async () => {
    const app = createApp({ db });
    const now = Date.now();

    // 1. Primordial task completed before deadline -> counts as completedBeforeDeadline
    const pOnTime = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Urgent report',
        userPriority: 'LOW',
        dueAt: now + 2 * 3_600_000,
      });
    expect(pOnTime.body.task.effectivePriority).toBe('CRITICAL');

    await request(app)
      .patch(`/api/v1/tasks/${pOnTime.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    // 2. Another primordial task completed and then reopened -> should not inflate count
    const pReopened = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Reopened urgent',
        userPriority: 'HIGH',
        dueAt: now + 10 * 3_600_000,
      });
    await request(app)
      .patch(`/api/v1/tasks/${pReopened.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });
    await request(app)
      .patch(`/api/v1/tasks/${pReopened.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: false });

    // 3. Overdue uncompleted primordial task -> counts as ignored
    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Missed deadline',
        userPriority: 'LOW',
        dueAt: now - 60_000,
      });

    const stats = await request(app)
      .get('/api/v1/stats')
      .set('x-device-id', deviceId);

    expect(stats.status).toBe(200);
    expect(stats.body.primordial).toEqual({
      completedBeforeDeadline: 1,
      ignored: 1,
      activePending: 1, // pReopened is still pending and not overdue
      completionRate: 0.5,
    });
  });

  it('exports productivity stats as downloadable JSON and CSV, and validates query params', async () => {
    const app = createApp({ db });

    const taskRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Exported task', userPriority: 'HIGH' });
    await request(app)
      .patch(`/api/v1/tasks/${taskRes.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    const csvRes = await request(app)
      .get('/api/v1/stats/export?format=csv&days=3')
      .set('x-device-id', deviceId);

    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.headers['content-disposition']).toBe(
      'attachment; filename="deep-work-stats-3d.csv"'
    );
    const lines = csvRes.text.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      'date,sessions_completed,focus_ms,focus_minutes,tasks_completed,primordial_completed,primordial_ignored'
    );
    expect(lines[3]).toBe('2026-11-20,0,0,0,1,1,0');

    const jsonRes = await request(app)
      .get('/api/v1/stats/export?format=json&days=3')
      .set('x-device-id', deviceId);

    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers['content-type']).toContain('application/json');
    expect(jsonRes.headers['content-disposition']).toBe(
      'attachment; filename="deep-work-stats-3d.json"'
    );
    const parsed = JSON.parse(jsonRes.text) as {
      windowDays: number;
      exportedAt: string;
      summary: { totals: { tasksCompleted: number } };
    };
    expect(parsed.windowDays).toBe(3);
    expect(parsed.summary.totals.tasksCompleted).toBe(1);

    // Invalid params -> 400 VALIDATION_ERROR
    expect(
      (await request(app).get('/api/v1/stats?days=0').set('x-device-id', deviceId)).status
    ).toBe(400);
    expect(
      (await request(app).get('/api/v1/stats/export?format=xml').set('x-device-id', deviceId))
        .status
    ).toBe(400);
  });

  it('excludes paused duration from productivity.byHour and peakHour and handles cross-day task reopen & intermediate edits', async () => {
    const app = createApp({ db });

    // 1. Focus session at 10:00 UTC: 5m focus -> 10m pause -> resume -> 5m focus -> end (10m actual focus, 20m wall-clock)
    vi.setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const session = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const sessionId = session.body.session.id as string;

    vi.advanceTimersByTime(5 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({});
    vi.advanceTimersByTime(10 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${sessionId}/resume`)
      .set('x-device-id', deviceId)
      .send({});
    vi.advanceTimersByTime(5 * 60_000);
    await request(app)
      .post(`/api/v1/sessions/${sessionId}/end`)
      .set('x-device-id', deviceId)
      .send({});

    // 2. On Day 1 (2026-11-19), create and complete a HIGH priority (primordial) task on time,
    // then edit its title while still completed
    const taskRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Primordial Day 1',
        userPriority: 'HIGH',
        dueAt: Date.now() + 6 * 3_600_000,
      });
    const taskId = taskRes.body.task.id as string;

    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    // Intermediate edit while completed
    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ title: 'Primordial Day 1 (Edited)', tags: ['Edited'] });

    // 3. On Day 2 (2026-11-20), reopen the task -> must decrement Day 1's tasks_completed and primordial_completed
    vi.setSystemTime(new Date('2026-11-20T15:00:00.000Z'));
    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: false });

    const stats = await request(app)
      .get('/api/v1/stats?days=7')
      .set('x-device-id', deviceId);

    expect(stats.status).toBe(200);
    expect(stats.body.totals.focusMs).toBe(10 * 60_000);
    expect(stats.body.productivity.byHour[10]).toEqual({
      hour: 10,
      focusCycles: 1,
      focusMs: 10 * 60_000,
      tasksCompleted: 0,
    });
    expect(stats.body.productivity.peakHour).toEqual({
      hour: 10,
      focusMs: 10 * 60_000,
      tasksCompleted: 0,
    });
    expect(stats.body.totals.tasksCompleted).toBe(0);
    expect(stats.body.primordial.completedBeforeDeadline).toBe(0);
    const day1Point = stats.body.productivity.byDay.find(
      (d: { date: string }) => d.date === '2026-11-19'
    );
    expect(day1Point?.tasksCompleted).toBe(0);
    expect(day1Point?.primordialCompleted).toBe(0);
  });
});
