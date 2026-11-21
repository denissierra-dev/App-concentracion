import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { EventLogRepository } from '../src/repositories/eventLogRepository.js';
import { SessionRepository } from '../src/repositories/sessionRepository.js';
import { StatsRepository } from '../src/repositories/statsRepository.js';

describe('Fase 1 & 2: Sesiones, Plan Precomputado y Ciclos/Descansos', () => {
  let db: AppDatabase;
  let deviceId: string;
  let userId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T20:00:00.000Z'));

    db = createDatabase(':memory:');
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    deviceId = reg.body.deviceId;
    userId = reg.body.user.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('POST /api/v1/sessions generates 4 cycles with 5 min short breaks and 20 min long break for 25 min focus', async () => {
    const app = createApp({ db });
    const res = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 4 });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.session.version).toBe(1);
    expect(res.body.session.status).toBe('active');

    const plan = res.body.session.plan;
    expect(plan).toHaveLength(8); // 4 focus + 4 breaks

    // Cycle 1: 25m focus, 5m short_break
    expect(plan[0]).toMatchObject({ cycleNumber: 1, phaseType: 'focus', durationMs: 25 * 60_000 });
    expect(plan[1]).toMatchObject({ cycleNumber: 1, phaseType: 'short_break', durationMs: 5 * 60_000 });

    // Cycle 4: 25m focus, 20m long_break
    expect(plan[6]).toMatchObject({ cycleNumber: 4, phaseType: 'focus', durationMs: 25 * 60_000 });
    expect(plan[7]).toMatchObject({ cycleNumber: 4, phaseType: 'long_break', durationMs: 20 * 60_000 });

    // Verify contiguous timestamps
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].startsAt).toBe(plan[i - 1].endsAt);
    }
  });

  it('POST /api/v1/sessions applies 10 min short break when focusDurationMin > 40', async () => {
    const app = createApp({ db });
    const res = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 45, totalCycles: 2 });

    expect(res.status).toBe(201);
    const plan = res.body.session.plan;
    expect(plan[1]).toMatchObject({ phaseType: 'short_break', durationMs: 10 * 60_000 });
  });

  it('POST /api/v1/sessions enforces authoritative bounds and is idempotent by sessionId', async () => {
    const app = createApp({ db });

    const invalid = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 2, totalCycles: 2 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const sessionId = crypto.randomUUID();
    const first = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ sessionId, focusDurationMin: 30, totalCycles: 2 });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const retry = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ sessionId, focusDurationMin: 30, totalCycles: 2 });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.session.id).toBe(sessionId);
  });

  it('pause and resume update accumulatedPauseMs, shift future endsAt, and bump version', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 2 });

    const sessionId = created.body.session.id;
    const originalStartsAt = created.body.session.plan[0].startsAt;
    const originalEndsAt = created.body.session.plan[0].endsAt;
    const originalBreakStartsAt = created.body.session.plan[1].startsAt;
    const originalBreakEndsAt = created.body.session.plan[1].endsAt;

    vi.advanceTimersByTime(60_000); // 1 min into focus
    const paused = await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({});

    expect(paused.status).toBe(200);
    expect(paused.body.session.status).toBe('paused');
    expect(paused.body.session.version).toBe(2);

    // Pausing again returns 409
    const doublePause = await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({});
    expect(doublePause.status).toBe(409);

    vi.advanceTimersByTime(120_000); // paused for 2 min
    const resumed = await request(app)
      .post(`/api/v1/sessions/${sessionId}/resume`)
      .set('x-device-id', deviceId)
      .send({});

    expect(resumed.status).toBe(200);
    expect(resumed.body.session.status).toBe('active');
    expect(resumed.body.session.accumulatedPauseMs).toBe(120_000);
    expect(resumed.body.session.version).toBe(3);
    expect(resumed.body.session.plan[0].startsAt).toBe(originalStartsAt);
    expect(resumed.body.session.plan[0].endsAt).toBe(originalEndsAt + 120_000);
    expect(resumed.body.session.plan[1].startsAt).toBe(originalBreakStartsAt + 120_000);
    expect(resumed.body.session.plan[1].endsAt).toBe(originalBreakEndsAt + 120_000);
    expect(resumed.body.session.plan[1].startsAt).toBe(resumed.body.session.plan[0].endsAt);
  });

  it('skip advances currentIndex, re-anchors remaining phases, and completes on final phase', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 }); // 2 phases: focus (0), short_break (1)

    const sessionId = created.body.session.id;

    vi.advanceTimersByTime(30_000);
    const skipToBreak = await request(app)
      .post(`/api/v1/sessions/${sessionId}/skip`)
      .set('x-device-id', deviceId)
      .send({});

    expect(skipToBreak.status).toBe(200);
    expect(skipToBreak.body.session.currentIndex).toBe(1);
    expect(skipToBreak.body.session.status).toBe('active');
    expect(skipToBreak.body.session.version).toBe(2);
    expect(skipToBreak.body.session.plan[1].startsAt).toBe(Date.now());

    const skipFinal = await request(app)
      .post(`/api/v1/sessions/${sessionId}/skip`)
      .set('x-device-id', deviceId)
      .send({});

    expect(skipFinal.status).toBe(200);
    expect(skipFinal.body.session.status).toBe('completed');
    expect(skipFinal.body.session.endedAt).toBe(Date.now());
  });

  it('reset and end close the session and record immutable events; isolates users', async () => {
    const app = createApp({ db });
    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });

    // Other user cannot access s1
    const otherReg = await request(app).post('/api/v1/auth/device').send({});
    const forbidden = await request(app)
      .get(`/api/v1/sessions/${s1.body.session.id}/state`)
      .set('x-device-id', otherReg.body.deviceId);
    expect(forbidden.status).toBe(404);

    const resetRes = await request(app)
      .post(`/api/v1/sessions/${s1.body.session.id}/reset`)
      .set('x-device-id', deviceId)
      .send({});
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.session.status).toBe('reset');

    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });

    const endRes = await request(app)
      .post(`/api/v1/sessions/${s2.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});
    expect(endRes.status).toBe(200);
    expect(endRes.body.session.status).toBe('completed');

    const events = new EventLogRepository(db).listByUser(userId);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('SESSION_STARTED');
    expect(types).toContain('SESSION_RESET');
    expect(types).toContain('SESSION_ENDED');
  });

  it('auto-completes expired active sessions on GET /state and rejects pause with 409', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 }); // 25m focus + 5m break = 30m total

    const sessionId = created.body.session.id;
    const finalEndsAt = created.body.session.plan[1].endsAt;

    // Advance past the entire session plan (e.g. 2 hours later)
    vi.advanceTimersByTime(2 * 60 * 60_000);

    const pauseExpired = await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({});
    expect(pauseExpired.status).toBe(409);
    expect(pauseExpired.body.error.code).toBe('INVALID_SESSION_STATE');

    const stateRes = await request(app)
      .get(`/api/v1/sessions/${sessionId}/state`)
      .set('x-device-id', deviceId);
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.session.status).toBe('completed');
    expect(stateRes.body.session.endedAt).toBe(finalEndsAt);
    expect(stateRes.body.session.currentIndex).toBe(2);
    expect(stateRes.body.currentPhase).toBeNull();
  });

  it('end/reset/skip compute currentIndex on active sessions and accumulate pause time when paused', async () => {
    const app = createApp({ db });

    // Case A: end while active in phase 1 (short_break) computes currentIndex = 1
    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 2 });
    const s1Id = s1.body.session.id;

    vi.advanceTimersByTime(26 * 60_000); // 26m -> inside short_break (index 1)
    const endActive = await request(app)
      .post(`/api/v1/sessions/${s1Id}/end`)
      .set('x-device-id', deviceId)
      .send({});
    expect(endActive.status).toBe(200);
    expect(endActive.body.session.currentIndex).toBe(1);

    // Case B: pause for 90s then skip accumulates 90_000ms pause time
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 2 });
    const s2Id = s2.body.session.id;

    await request(app).post(`/api/v1/sessions/${s2Id}/pause`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(90_000);
    const skipPaused = await request(app)
      .post(`/api/v1/sessions/${s2Id}/skip`)
      .set('x-device-id', deviceId)
      .send({});
    expect(skipPaused.status).toBe(200);
    expect(skipPaused.body.session.accumulatedPauseMs).toBe(90_000);
    expect(skipPaused.body.session.pausedAt).toBeNull();

    // Case C: pause for 45s then reset accumulates 45_000ms extra pause time
    await request(app).post(`/api/v1/sessions/${s2Id}/pause`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(45_000);
    const resetPaused = await request(app)
      .post(`/api/v1/sessions/${s2Id}/reset`)
      .set('x-device-id', deviceId)
      .send({});
    expect(resetPaused.status).toBe(200);
    expect(resetPaused.body.session.accumulatedPauseMs).toBe(135_000);
    expect(resetPaused.body.session.pausedAt).toBeNull();
  });

  it('prevents concurrent active sessions and exposes GET /api/v1/sessions/active', async () => {
    const app = createApp({ db });

    const emptyActive = await request(app)
      .get('/api/v1/sessions/active')
      .set('x-device-id', deviceId);
    expect(emptyActive.status).toBe(200);
    expect(emptyActive.body.session).toBeNull();

    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    expect(s1.status).toBe(201);

    // Creating another session while s1 is active fails with 409
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe('ACTIVE_SESSION_EXISTS');

    // Recover active session
    const recovered = await request(app)
      .get('/api/v1/sessions/active')
      .set('x-device-id', deviceId);
    expect(recovered.status).toBe(200);
    expect(recovered.body.session.id).toBe(s1.body.session.id);

    // Once expired, /active returns null and allows starting a new session
    vi.advanceTimersByTime(60 * 60_000);
    const expiredActive = await request(app)
      .get('/api/v1/sessions/active')
      .set('x-device-id', deviceId);
    expect(expiredActive.status).toBe(200);
    expect(expiredActive.body.session).toBeNull();

    const s3 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    expect(s3.status).toBe(201);
  });

  it('control endpoints are idempotent by eventId and prevent double-skip or 409 on retry', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 2 });
    const sessionId = created.body.session.id;

    // Retry pause with same eventId -> 200 idempotent, version stays 2
    const pauseEventId = crypto.randomUUID();
    const p1 = await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({ eventId: pauseEventId });
    expect(p1.status).toBe(200);
    expect(p1.body.idempotent).toBe(false);
    expect(p1.body.session.version).toBe(2);

    const p2 = await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({ eventId: pauseEventId });
    expect(p2.status).toBe(200);
    expect(p2.body.idempotent).toBe(true);
    expect(p2.body.session.version).toBe(2);

    // Retry skip with same eventId -> does NOT skip a second phase
    const skipEventId = crypto.randomUUID();
    const sk1 = await request(app)
      .post(`/api/v1/sessions/${sessionId}/skip`)
      .set('x-device-id', deviceId)
      .send({ eventId: skipEventId });
    expect(sk1.status).toBe(200);
    expect(sk1.body.session.currentIndex).toBe(1);
    expect(sk1.body.session.version).toBe(3);

    const sk2 = await request(app)
      .post(`/api/v1/sessions/${sessionId}/skip`)
      .set('x-device-id', deviceId)
      .send({ eventId: skipEventId });
    expect(sk2.status).toBe(200);
    expect(sk2.body.idempotent).toBe(true);
    expect(sk2.body.session.currentIndex).toBe(1);
    expect(sk2.body.session.version).toBe(3);
  });

  it('rejects cross-user sessionId/eventId collisions with 409 and rolls back failed transactions', async () => {
    const app = createApp({ db });
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    const otherDeviceId = otherUser.body.deviceId;

    const sharedSessionId = crypto.randomUUID();
    const sharedEventId = crypto.randomUUID();

    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ sessionId: sharedSessionId, eventId: sharedEventId, focusDurationMin: 25, totalCycles: 1 });
    expect(s1.status).toBe(201);

    // Another user trying to reuse sharedSessionId gets 409 SESSION_ID_CONFLICT (not 500)
    const crossSession = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', otherDeviceId)
      .send({ sessionId: sharedSessionId, focusDurationMin: 25, totalCycles: 1 });
    expect(crossSession.status).toBe(409);
    expect(crossSession.body.error.code).toBe('SESSION_ID_CONFLICT');

    // Another user trying to reuse sharedEventId in their own session gets 409 EVENT_ID_CONFLICT
    // and their session stays in 'active' (rolled back)
    const otherS1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', otherDeviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    expect(otherS1.status).toBe(201);

    const crossEvent = await request(app)
      .post(`/api/v1/sessions/${otherS1.body.session.id}/pause`)
      .set('x-device-id', otherDeviceId)
      .send({ eventId: sharedEventId });
    expect(crossEvent.status).toBe(409);
    expect(crossEvent.body.error.code).toBe('EVENT_ID_CONFLICT');

    const checkState = await request(app)
      .get(`/api/v1/sessions/${otherS1.body.session.id}/state`)
      .set('x-device-id', otherDeviceId);
    expect(checkState.body.session.status).toBe('active');
    expect(checkState.body.session.version).toBe(1);
  });

  it('SessionRepository.update enforces optimistic concurrency via version', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });

    const repo = new SessionRepository(db);
    const session = repo.findByIdForUser(created.body.session.id, userId)!;

    expect(() =>
      repo.update({ ...session, version: 2 }, 999)
    ).toThrowError(/modified concurrently/i);
  });

  it('populates cycles and daily_stats when completing a session via end or expiration', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const sessionId = created.body.session.id;

    // Advance 10 minutes into focus and end session
    vi.advanceTimersByTime(10 * 60_000);
    const ended = await request(app)
      .post(`/api/v1/sessions/${sessionId}/end`)
      .set('x-device-id', deviceId)
      .send({});
    expect(ended.status).toBe(200);

    const statsRepo = new StatsRepository(db);
    const today = new Date().toISOString().slice(0, 10);
    const daily = statsRepo.getDailyStats(userId, today);
    expect(daily).not.toBeNull();
    expect(daily?.sessionsCompleted).toBe(1);
    expect(daily?.focusMs).toBe(10 * 60_000);

    const cycleCount = db
      .prepare('SELECT COUNT(*) AS count FROM cycles WHERE session_id = ?')
      .get(sessionId) as { count: number };
    expect(cycleCount.count).toBe(1);
  });

  it('GET and PATCH /api/v1/preferences read, validate, and persist user preferences', async () => {
    const app = createApp({ db });

    const initial = await request(app)
      .get('/api/v1/preferences')
      .set('x-device-id', deviceId);
    expect(initial.status).toBe(200);
    expect(initial.body.preferences.focusDurationMin).toBe(25);
    expect(initial.body.preferences.volumeFocus).toBe(0.7);

    const invalid = await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({ volumeFocus: 1.5 });
    expect(invalid.status).toBe(400);

    const eventId = crypto.randomUUID();
    const updated = await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({
        focusDurationMin: 45,
        volumeFocus: 0.85,
        volumeBreak: 0.25,
        theme: 'dark',
        eventId,
      });
    expect(updated.status).toBe(200);
    expect(updated.body.preferences.focusDurationMin).toBe(45);
    expect(updated.body.preferences.volumeFocus).toBe(0.85);
    expect(updated.body.preferences.volumeBreak).toBe(0.25);
    expect(updated.body.preferences.theme).toBe('dark');

    // New session uses updated focusDurationMin preference automatically
    const session = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ totalCycles: 1 });
    expect(session.status).toBe(201);
    expect(session.body.session.plan[0].durationMs).toBe(45 * 60_000);
    expect(session.body.session.plan[1].durationMs).toBe(10 * 60_000);
  });

  it('POST /api/v1/sessions applies shortBreakMin and longBreakMin from user preferences', async () => {
    const app = createApp({ db });

    const prefRes = await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({
        focusDurationMin: 30,
        shortBreakMin: 12,
        longBreakMin: 35,
        cyclesBeforeLongBreak: 2,
      });
    expect(prefRes.status).toBe(200);
    expect(prefRes.body.preferences.shortBreakMin).toBe(12);
    expect(prefRes.body.preferences.longBreakMin).toBe(35);

    const session = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ totalCycles: 2 });
    expect(session.status).toBe(201);

    const summary = session.body.session.plan.map(
      (p: { phaseType: string; durationMs: number }) => `${p.phaseType}:${p.durationMs / 60_000}m`
    );
    expect(summary).toEqual([
      'focus:30m',
      'short_break:12m',
      'focus:30m',
      'long_break:35m',
    ]);

    // Also applies custom shortBreakMin even when focusDurationMin > 40
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 50, totalCycles: 1 });
    expect(s2.status).toBe(409); // active session exists

    await request(app)
      .post(`/api/v1/sessions/${session.body.session.id}/end`)
      .set('x-device-id', deviceId)
      .send({});

    const s3 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 50, totalCycles: 1 });
    expect(s3.status).toBe(201);
    expect(s3.body.session.plan[1]).toMatchObject({
      phaseType: 'short_break',
      durationMs: 12 * 60_000,
    });
  });

  it('excludes paused duration from daily_stats.focusMs on early end, full completion, and end-while-paused', async () => {
    const app = createApp({ db });
    const statsRepo = new StatsRepository(db);
    const today = new Date().toISOString().slice(0, 10);

    // Case 1: 5m focus -> 10m pause -> resume -> 5m focus -> early end => 10m focusMs (not 20m)
    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const id1 = s1.body.session.id as string;

    vi.advanceTimersByTime(5 * 60_000);
    await request(app).post(`/api/v1/sessions/${id1}/pause`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(10 * 60_000);
    await request(app).post(`/api/v1/sessions/${id1}/resume`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(5 * 60_000);
    await request(app).post(`/api/v1/sessions/${id1}/end`).set('x-device-id', deviceId).send({});

    expect(statsRepo.getDailyStats(userId, today)?.focusMs).toBe(10 * 60_000);

    // Case 2: 5m focus -> 10m pause -> end while paused => +5m focusMs (total 15m, not 25m)
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const id2 = s2.body.session.id as string;

    vi.advanceTimersByTime(5 * 60_000);
    await request(app).post(`/api/v1/sessions/${id2}/pause`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(10 * 60_000);
    await request(app).post(`/api/v1/sessions/${id2}/end`).set('x-device-id', deviceId).send({});

    expect(statsRepo.getDailyStats(userId, today)?.focusMs).toBe(15 * 60_000);

    // Case 3: 5m focus -> 10m pause -> resume -> remaining 20m focus -> end during break => +25m (total 40m)
    const s3 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const id3 = s3.body.session.id as string;

    vi.advanceTimersByTime(5 * 60_000);
    await request(app).post(`/api/v1/sessions/${id3}/pause`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(10 * 60_000);
    await request(app).post(`/api/v1/sessions/${id3}/resume`).set('x-device-id', deviceId).send({});
    vi.advanceTimersByTime(21 * 60_000);
    await request(app).post(`/api/v1/sessions/${id3}/end`).set('x-device-id', deviceId).send({});

    expect(statsRepo.getDailyStats(userId, today)?.focusMs).toBe(40 * 60_000);
  });

  it('always ensures long_break is at least double short_break, including 60m focus sessions', async () => {
    const app = createApp({ db });

    // Even if user previously saved short=5, long=10 (double of 5),
    // switching to a 60m focus session bumps short_break to 10m and long_break to 20m (never 10m/10m).
    const prefRes = await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({ shortBreakMin: 5, longBreakMin: 10 });
    expect(prefRes.status).toBe(200);
    expect(prefRes.body.preferences.shortBreakMin).toBe(5);
    expect(prefRes.body.preferences.longBreakMin).toBe(10);

    const session60 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 60, totalCycles: 4 });
    expect(session60.status).toBe(201);

    const plan60 = session60.body.session.plan;
    expect(plan60[1]).toMatchObject({ phaseType: 'short_break', durationMs: 10 * 60_000 });
    expect(plan60[7]).toMatchObject({ phaseType: 'long_break', durationMs: 20 * 60_000 });

    // Updating shortBreakMin to 15 automatically raises longBreakMin to at least 30 (2x)
    const pref15 = await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({ shortBreakMin: 15 });
    expect(pref15.status).toBe(200);
    expect(pref15.body.preferences.longBreakMin).toBe(30);
  });

  it('marks intermediate skipped focus phases as skipped without crediting phantom focusMs or completed cycles', async () => {
    const app = createApp({ db });
    const statsRepo = new StatsRepository(db);
    const today = new Date().toISOString().slice(0, 10);

    // 2 cycles: phase 0 (focus 25m), phase 1 (break 5m), phase 2 (focus 25m), phase 3 (break 5m)
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 2 });
    const sessionId = created.body.session.id as string;

    // 1 minute into phase 0 (focus), user skips phase 0 -> advances to phase 1 (short_break)
    vi.advanceTimersByTime(60_000);
    const skippedFocus = await request(app)
      .post(`/api/v1/sessions/${sessionId}/skip`)
      .set('x-device-id', deviceId)
      .send({});
    expect(skippedFocus.status).toBe(200);
    expect(skippedFocus.body.session.plan[0].skipped).toBe(true);
    expect(skippedFocus.body.session.currentIndex).toBe(1);

    // Complete phase 1 (5m break) and phase 2 (25m focus), then end 1m into phase 3
    vi.advanceTimersByTime(31 * 60_000);
    const ended = await request(app)
      .post(`/api/v1/sessions/${sessionId}/end`)
      .set('x-device-id', deviceId)
      .send({});
    expect(ended.status).toBe(200);

    // Only phase 2 (25m) must be credited; skipped phase 0 must NOT add phantom focusMs or completed cycle
    expect(statsRepo.getDailyStats(userId, today)?.focusMs).toBe(25 * 60_000);
    expect(statsRepo.countCompletedFocusCycles(userId)).toBe(1);

    const cycles = db
      .prepare(
        'SELECT cycle_index, phase_type, completed_at, skipped FROM cycles WHERE session_id = ? ORDER BY cycle_index ASC'
      )
      .all(sessionId) as Array<{
      cycle_index: number;
      phase_type: string;
      completed_at: number | null;
      skipped: number;
    }>;
    expect(cycles[0]).toMatchObject({
      cycle_index: 0,
      phase_type: 'focus',
      completed_at: null,
      skipped: 1,
    });
    expect(cycles[2]).toMatchObject({
      cycle_index: 2,
      phase_type: 'focus',
      skipped: 0,
    });
    expect(cycles[2]?.completed_at).not.toBeNull();
  });

  it('persists reconcileExpiredActiveSession in SQLite even when control actions return 409', async () => {
    const app = createApp({ db });
    const sessionRepo = new SessionRepository(db);
    const statsRepo = new StatsRepository(db);

    // Case 1: pause with stale expectedVersion on an expired session returns 409 VERSION_CONFLICT
    // AND commits the reconciled 'completed' state (version 2) in SQLite
    const s1 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const id1 = s1.body.session.id as string;

    vi.advanceTimersByTime(60 * 60_000);

    const conflictPause = await request(app)
      .post(`/api/v1/sessions/${id1}/pause`)
      .set('x-device-id', deviceId)
      .send({ expectedVersion: 1 });
    expect(conflictPause.status).toBe(409);
    expect(conflictPause.body.error.code).toBe('VERSION_CONFLICT');
    expect(conflictPause.body.error.details).toEqual({
      serverVersion: 2,
      serverStatus: 'completed',
    });

    const dbSession1 = sessionRepo.findByIdForUser(id1, userId);
    expect(dbSession1?.status).toBe('completed');
    expect(dbSession1?.version).toBe(2);
    expect(statsRepo.countCompletedFocusCycles(userId)).toBe(1);

    // Case 2: skip/reset/end without expectedVersion on an expired session returns 409 INVALID_SESSION_STATE
    // AND commits the reconciled 'completed' state in SQLite
    const s2 = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const id2 = s2.body.session.id as string;

    vi.advanceTimersByTime(60 * 60_000);

    const invalidEnd = await request(app)
      .post(`/api/v1/sessions/${id2}/end`)
      .set('x-device-id', deviceId)
      .send({});
    expect(invalidEnd.status).toBe(409);
    expect(invalidEnd.body.error.code).toBe('INVALID_SESSION_STATE');

    const dbSession2 = sessionRepo.findByIdForUser(id2, userId);
    expect(dbSession2?.status).toBe('completed');
    expect(dbSession2?.version).toBe(2);
    expect(statsRepo.countCompletedFocusCycles(userId)).toBe(2);
  });
});
