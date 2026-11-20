import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { EventLogRepository } from '../src/repositories/eventLogRepository.js';
import { StatsRepository } from '../src/repositories/statsRepository.js';
import { PriorityRecalcQueue } from '../src/services/priorityQueue.js';

describe('Fase 5: Sistema de Tareas (To-Do List)', () => {
  let db: AppDatabase;
  let deviceId: string;
  let userId: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    deviceId = reg.body.deviceId;
    userId = reg.body.user.id;
  });

  afterEach(() => {
    db.close();
  });

  it('requires authentication for /api/v1/tasks endpoints', async () => {
    const app = createApp({ db });
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(401);
  });

  it('supports full CRUD, server-calculated counts, and user isolation', async () => {
    const app = createApp({ db });

    // Create two tasks
    const t1 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Escribir arquitectura', description: 'Fase 5 del back-end' });
    expect(t1.status).toBe(201);
    expect(t1.body.created).toBe(true);
    expect(t1.body.task.completed).toBe(false);
    expect(t1.body.counts).toEqual({ total: 1, pending: 1, completed: 0 });

    const dueAt = Date.now() + 3_600_000;
    const t2 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Revisar PR', dueAt });
    expect(t2.status).toBe(201);
    expect(t2.body.task.dueAt).toBe(dueAt);
    expect(t2.body.counts).toEqual({ total: 2, pending: 2, completed: 0 });

    // List tasks for user
    const list = await request(app)
      .get('/api/v1/tasks')
      .set('x-device-id', deviceId);
    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(2);
    expect(list.body.counts).toEqual({ total: 2, pending: 2, completed: 0 });

    // Complete task 1 -> updates counts & daily_stats
    const complete = await request(app)
      .patch(`/api/v1/tasks/${t1.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });
    expect(complete.status).toBe(200);
    expect(complete.body.task.completed).toBe(true);
    expect(complete.body.task.completedAt).toEqual(expect.any(Number));
    expect(complete.body.counts).toEqual({ total: 2, pending: 1, completed: 1 });

    const today = new Date().toISOString().slice(0, 10);
    const statsAfterComplete = new StatsRepository(db).getDailyStats(userId, today);
    expect(statsAfterComplete?.tasksCompleted).toBe(1);

    // Reopen task 1 -> reverts counts & daily_stats
    const reopen = await request(app)
      .patch(`/api/v1/tasks/${t1.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: false, title: 'Escribir arquitectura v2' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.task.completed).toBe(false);
    expect(reopen.body.task.completedAt).toBeNull();
    expect(reopen.body.task.title).toBe('Escribir arquitectura v2');
    expect(reopen.body.counts).toEqual({ total: 2, pending: 2, completed: 0 });

    const statsAfterReopen = new StatsRepository(db).getDailyStats(userId, today);
    expect(statsAfterReopen?.tasksCompleted).toBe(0);

    // Other user cannot read, update, or delete this user's tasks
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    const otherDeviceId = otherUser.body.deviceId;

    const otherList = await request(app).get('/api/v1/tasks').set('x-device-id', otherDeviceId);
    expect(otherList.body.tasks).toHaveLength(0);
    expect(otherList.body.counts).toEqual({ total: 0, pending: 0, completed: 0 });

    const otherPatch = await request(app)
      .patch(`/api/v1/tasks/${t1.body.task.id}`)
      .set('x-device-id', otherDeviceId)
      .send({ completed: true });
    expect(otherPatch.status).toBe(404);

    // Delete task 2
    const del = await request(app)
      .delete(`/api/v1/tasks/${t2.body.task.id}`)
      .set('x-device-id', deviceId);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.counts).toEqual({ total: 1, pending: 1, completed: 0 });

    const events = new EventLogRepository(db).listByUser(userId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('TASK_CREATED');
    expect(eventTypes).toContain('TASK_UPDATED');
    expect(eventTypes).toContain('TASK_DELETED');
  });

  it('enforces idempotency by task id and eventId, and rejects cross-user taskId collision with 409', async () => {
    const app = createApp({ db });
    const taskId = crypto.randomUUID();
    const createEventId = crypto.randomUUID();

    const c1 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ id: taskId, title: 'Tarea idempotente', eventId: createEventId });
    expect(c1.status).toBe(201);

    const c2 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ id: taskId, title: 'Tarea idempotente', eventId: createEventId });
    expect(c2.status).toBe(200);
    expect(c2.body.created).toBe(false);

    // Cross-user collision returns 409 TASK_ID_CONFLICT
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    const collision = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', otherUser.body.deviceId)
      .send({ id: taskId, title: 'Colision' });
    expect(collision.status).toBe(409);
    expect(collision.body.error.code).toBe('TASK_ID_CONFLICT');

    // Idempotent PATCH & DELETE by eventId
    const patchEventId = crypto.randomUUID();
    const p1 = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: true, eventId: patchEventId });
    expect(p1.status).toBe(200);
    expect(p1.body.idempotent).toBe(false);

    const p2 = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: true, eventId: patchEventId });
    expect(p2.status).toBe(200);
    expect(p2.body.idempotent).toBe(true);

    const deleteEventId = crypto.randomUUID();
    const d1 = await request(app)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ eventId: deleteEventId });
    expect(d1.status).toBe(200);
    expect(d1.body.idempotent).toBe(false);

    const d2 = await request(app)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ eventId: deleteEventId });
    expect(d2.status).toBe(200);
    expect(d2.body.idempotent).toBe(true);
  });

  it('enqueues non-blocking Phase 6.5A priority recalculation on create, dueAt edit, complete, and reopen', async () => {
    const enqueued: string[] = [];
    const priorityQueue = new PriorityRecalcQueue((job) => {
      enqueued.push(job.taskId);
    });

    const app = createApp({ db, priorityQueue });

    const created = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Con fecha límite' });
    const taskId = created.body.task.id as string;

    // Wait microtask flush
    await Promise.resolve();
    expect(enqueued).toHaveLength(1);

    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ dueAt: Date.now() + 7_200_000 });
    await Promise.resolve();
    expect(enqueued).toHaveLength(2);

    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });
    await Promise.resolve();
    expect(enqueued).toHaveLength(3);

    await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ completed: false });
    await Promise.resolve();
    expect(enqueued).toHaveLength(4);
    expect(enqueued.every((id) => id === taskId)).toBe(true);
  });

  it('rejects invalid task payloads cleanly', async () => {
    const app = createApp({ db });

    const emptyTitle = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: '   ' });
    expect(emptyTitle.status).toBe(400);

    const created = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Valida' });

    const emptyPatch = await request(app)
      .patch(`/api/v1/tasks/${created.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({});
    expect(emptyPatch.status).toBe(400);
  });
});
