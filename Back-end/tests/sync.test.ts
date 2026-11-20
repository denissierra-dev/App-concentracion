import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { StatsRepository } from '../src/repositories/statsRepository.js';
import { PriorityRecalcQueue } from '../src/services/priorityQueue.js';

describe('Fase 4 (4A & 4B): Contrato de Sincronización por Eventos (/api/v1/sync)', () => {
  let db: AppDatabase;
  let deviceId: string;
  let userId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T21:30:00.000Z'));

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

  it('requires authentication for /api/v1/sync and /api/v1/sync/state', async () => {
    const app = createApp({ db });

    const getState = await request(app).get('/api/v1/sync/state');
    expect(getState.status).toBe(401);

    const postSync = await request(app).post('/api/v1/sync').send({ events: [] });
    expect(postSync.status).toBe(401);
  });

  it('GET /api/v1/sync/state returns authoritative hydration snapshot', async () => {
    const app = createApp({ db });
    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Hydration task' });

    const sessionRes = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });

    const state = await request(app)
      .get('/api/v1/sync/state')
      .set('x-device-id', deviceId);

    expect(state.status).toBe(200);
    expect(state.body.activeSession.id).toBe(sessionRes.body.session.id);
    expect(state.body.currentPhase.phaseType).toBe('focus');
    expect(state.body.preferences.focusDurationMin).toBe(25);
    expect(state.body.tasks).toHaveLength(1);
    expect(state.body.taskCounts).toEqual({ total: 1, pending: 1, completed: 0 });
  });

  it('POST /api/v1/sync processes queued batch idempotently across tasks, preferences, and sessions', async () => {
    const enqueuedTasks: string[] = [];
    const priorityQueue = new PriorityRecalcQueue((job) => {
      enqueuedTasks.push(job.taskId);
    });

    const app = createApp({ db, priorityQueue });
    const taskId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    const batch = [
      {
        eventId: crypto.randomUUID(),
        entityType: 'preference',
        entityId: userId,
        eventType: 'PREFERENCES_UPDATED',
        payload: { focusDurationMin: 30, volumeFocus: 0.8 },
      },
      {
        eventId: crypto.randomUUID(),
        entityType: 'task',
        entityId: taskId,
        eventType: 'TASK_CREATED',
        payload: { title: 'Offline queued task' },
      },
      {
        eventId: crypto.randomUUID(),
        entityType: 'task',
        entityId: taskId,
        eventType: 'TASK_UPDATED',
        payload: { completed: true },
      },
      {
        eventId: crypto.randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        eventType: 'SESSION_STARTED',
        payload: { totalCycles: 1 },
      },
      {
        eventId: crypto.randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        eventType: 'SESSION_PAUSED',
        expectedVersion: 1,
      },
      {
        eventId: crypto.randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        eventType: 'SESSION_RESUMED',
        expectedVersion: 2,
      },
    ];

    const first = await request(app)
      .post('/api/v1/sync')
      .set('x-device-id', deviceId)
      .send({ events: batch });

    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(first.body.snapshot.preferences.focusDurationMin).toBe(30);
    expect(first.body.snapshot.taskCounts).toEqual({ total: 1, pending: 0, completed: 1 });
    expect(first.body.snapshot.activeSession.id).toBe(sessionId);
    expect(first.body.snapshot.activeSession.version).toBe(3);
    expect(first.body.snapshot.activeSession.plan[0].durationMs).toBe(30 * 60_000);

    await Promise.resolve();
    expect(enqueuedTasks).toEqual([taskId]);

    const today = new Date().toISOString().slice(0, 10);
    expect(new StatsRepository(db).getDailyStats(userId, today)?.tasksCompleted).toBe(1);

    // Replaying exact same batch returns 'duplicate' without mutating again
    const replay = await request(app)
      .post('/api/v1/sync')
      .set('x-device-id', deviceId)
      .send({ events: batch });

    expect(replay.status).toBe(200);
    expect(replay.body.results.map((r: { status: string }) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(replay.body.snapshot.activeSession.version).toBe(3);
  });

  it('reports version conflicts per event without dropping independent events and returns fresh snapshot', async () => {
    const app = createApp({ db });
    const created = await request(app)
      .post('/api/v1/sessions')
      .set('x-device-id', deviceId)
      .send({ focusDurationMin: 25, totalCycles: 1 });
    const sessionId = created.body.session.id;

    // Server advances to version 2 via direct pause
    await request(app)
      .post(`/api/v1/sessions/${sessionId}/pause`)
      .set('x-device-id', deviceId)
      .send({});

    // Offline client sends stale expectedVersion: 1 for pause + a new task creation
    const taskId = crypto.randomUUID();
    const res = await request(app)
      .post('/api/v1/sync')
      .set('x-device-id', deviceId)
      .send({
        events: [
          {
            eventId: crypto.randomUUID(),
            entityType: 'session',
            entityId: sessionId,
            eventType: 'SESSION_PAUSED',
            expectedVersion: 1,
          },
          {
            eventId: crypto.randomUUID(),
            entityType: 'task',
            entityId: taskId,
            eventType: 'TASK_CREATED',
            payload: { title: 'Independent task survives session conflict' },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'VERSION_CONFLICT',
      details: { serverVersion: 2, serverStatus: 'paused' },
    });
    expect(res.body.results[1].status).toBe('applied');
    expect(res.body.snapshot.activeSession.version).toBe(2);
    expect(res.body.snapshot.taskCounts).toEqual({ total: 1, pending: 1, completed: 0 });
  });

  it('rejects non-authoritative 4A events like phase transitions or clock ticks with 400', async () => {
    const app = createApp({ db });

    const invalid = await request(app)
      .post('/api/v1/sync')
      .set('x-device-id', deviceId)
      .send({
        events: [
          {
            eventId: crypto.randomUUID(),
            entityType: 'session',
            entityId: crypto.randomUUID(),
            eventType: 'PHASE_TRANSITION',
          },
        ],
      });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('handles cross-user entityId and eventId collisions safely as conflicts', async () => {
    const app = createApp({ db });
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    const otherDeviceId = otherUser.body.deviceId;

    const sharedEventId = crypto.randomUUID();
    const sharedTaskId = crypto.randomUUID();

    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ id: sharedTaskId, eventId: sharedEventId, title: 'Owner task' });

    const otherSync = await request(app)
      .post('/api/v1/sync')
      .set('x-device-id', otherDeviceId)
      .send({
        events: [
          {
            eventId: sharedEventId,
            entityType: 'task',
            entityId: crypto.randomUUID(),
            eventType: 'TASK_CREATED',
            payload: { title: 'Reused eventId' },
          },
          {
            eventId: crypto.randomUUID(),
            entityType: 'task',
            entityId: sharedTaskId,
            eventType: 'TASK_CREATED',
            payload: { title: 'Reused taskId' },
          },
        ],
      });

    expect(otherSync.status).toBe(200);
    expect(otherSync.body.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'EVENT_ID_CONFLICT',
    });
    expect(otherSync.body.results[1]).toMatchObject({
      status: 'conflict',
      errorCode: 'TASK_ID_CONFLICT',
    });
  });
});
