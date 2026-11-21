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

    // Retrying POST /api/v1/tasks with the original createEventId after deletion must NOT resurrect the task
    const retryCreateAfterDelete = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ id: taskId, title: 'Tarea idempotente', eventId: createEventId });
    expect(retryCreateAfterDelete.status).toBe(200);
    expect(retryCreateAfterDelete.body.created).toBe(false);
    expect(retryCreateAfterDelete.body.task).toBeNull();
    expect(retryCreateAfterDelete.body.counts.total).toBe(0);
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

  it('Fase 6.0: supports userPriority, normalized tags, server sorting, and GET /tasks/tags', async () => {
    const app = createApp({ db, priorityQueue: new PriorityRecalcQueue() });
    const now = Date.now();

    const low = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Tarea baja',
        userPriority: 'LOW',
        tags: ['Casa', 'casa', '  Lectura  '],
        dueAt: now + 10_000,
      });
    expect(low.status).toBe(201);
    expect(low.body.task.userPriority).toBe('LOW');
    expect(low.body.task.effectivePriority).toBe('LOW');
    expect(low.body.task.tags).toEqual(['Casa', 'Lectura']);

    const high = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Tarea alta',
        userPriority: 'HIGH',
        tags: ['Trabajo', 'Backend'],
        dueAt: now + 50_000,
      });
    expect(high.status).toBe(201);
    expect(high.body.task.effectivePriority).toBe('HIGH');

    const med = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Tarea media',
        userPriority: 'MEDIUM',
        tags: ['Trabajo'],
      });
    expect(med.status).toBe(201);

    // Default server ordering: pending first, then HIGH -> MEDIUM -> LOW
    const defaultList = await request(app)
      .get('/api/v1/tasks')
      .set('x-device-id', deviceId);
    expect(defaultList.status).toBe(200);
    expect(defaultList.body.tasks.map((t: { title: string }) => t.title)).toEqual([
      'Tarea alta',
      'Tarea media',
      'Tarea baja',
    ]);

    // Update priority and tags via PATCH
    const promoted = await request(app)
      .patch(`/api/v1/tasks/${low.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ userPriority: 'HIGH', tags: ['Urgente', 'Casa'] });
    expect(promoted.status).toBe(200);
    expect(promoted.body.task.userPriority).toBe('HIGH');
    expect(promoted.body.task.effectivePriority).toBe('HIGH');
    expect(promoted.body.task.tags).toEqual(['Urgente', 'Casa']);

    // Sort by dueAt ascending (nulls last)
    const byDueAsc = await request(app)
      .get('/api/v1/tasks?sortBy=dueAt&sortOrder=asc')
      .set('x-device-id', deviceId);
    expect(byDueAsc.status).toBe(200);
    expect(byDueAsc.body.tasks.map((t: { title: string }) => t.title)).toEqual([
      'Tarea baja',
      'Tarea alta',
      'Tarea media',
    ]);

    // Distinct tags endpoint
    const tagsRes = await request(app)
      .get('/api/v1/tasks/tags')
      .set('x-device-id', deviceId);
    expect(tagsRes.status).toBe(200);
    expect(tagsRes.body.tags).toEqual(['Backend', 'Casa', 'Trabajo', 'Urgente']);
  });

  it('Fase 6.0: filters by status, priority, tag, overdue, hasDueDate, and escaped search', async () => {
    const app = createApp({ db, priorityQueue: new PriorityRecalcQueue() });
    const now = Date.now();

    const t1 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Avance 100% SQLite',
        description: 'Optimizar índices',
        userPriority: 'HIGH',
        tags: ['Backend'],
        dueAt: now - 60_000, // overdue
      });

    await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Avance 50% UI',
        description: 'Botones',
        userPriority: 'MEDIUM',
        tags: ['Frontend'],
        dueAt: now + 3_600_000,
      });

    const t3 = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Sin fecha',
        userPriority: 'LOW',
        tags: ['Backend'],
      });

    await request(app)
      .patch(`/api/v1/tasks/${t3.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });

    // Filter by tag (case-insensitive) + status=pending
    const backendPending = await request(app)
      .get('/api/v1/tasks?tag=backend&status=pending')
      .set('x-device-id', deviceId);
    expect(backendPending.status).toBe(200);
    expect(backendPending.body.filteredCount).toBe(1);
    expect(backendPending.body.counts).toEqual({ total: 3, pending: 2, completed: 1 });
    expect(backendPending.body.tasks[0].id).toBe(t1.body.task.id);

    // Filter by priority=MEDIUM
    const mediumOnly = await request(app)
      .get('/api/v1/tasks?priority=MEDIUM')
      .set('x-device-id', deviceId);
    expect(mediumOnly.body.tasks).toHaveLength(1);
    expect(mediumOnly.body.tasks[0].title).toBe('Avance 50% UI');

    // Filter by overdue=true
    const overdueOnly = await request(app)
      .get('/api/v1/tasks?overdue=true')
      .set('x-device-id', deviceId);
    expect(overdueOnly.body.tasks).toHaveLength(1);
    expect(overdueOnly.body.tasks[0].id).toBe(t1.body.task.id);

    // Filter by hasDueDate=false
    const noDue = await request(app)
      .get('/api/v1/tasks?hasDueDate=false')
      .set('x-device-id', deviceId);
    expect(noDue.body.tasks).toHaveLength(1);
    expect(noDue.body.tasks[0].id).toBe(t3.body.task.id);

    // Search with literal '%' must NOT match '50%'
    const searchPercent = await request(app)
      .get(`/api/v1/tasks?search=${encodeURIComponent('100%')}`)
      .set('x-device-id', deviceId);
    expect(searchPercent.status).toBe(200);
    expect(searchPercent.body.tasks).toHaveLength(1);
    expect(searchPercent.body.tasks[0].id).toBe(t1.body.task.id);

    // Search matches description too
    const searchDesc = await request(app)
      .get(`/api/v1/tasks?search=${encodeURIComponent('índices')}`)
      .set('x-device-id', deviceId);
    expect(searchDesc.body.tasks).toHaveLength(1);
    expect(searchDesc.body.tasks[0].id).toBe(t1.body.task.id);
  });

  it('Fase 6.5A: recalculates aiPriority, effectivePriority, priorityScore, priorityReason, and priorityComputedAt via default queue', async () => {
    const app = createApp({ db });
    const now = Date.now();

    const criticalRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Entrega urgente',
        userPriority: 'LOW',
        dueAt: now + 2 * 3_600_000, // 2h -> CRITICAL
      });
    expect(criticalRes.status).toBe(201);

    const highRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Entrega hoy',
        userPriority: 'LOW',
        dueAt: now + 12 * 3_600_000, // 12h -> HIGH
      });
    expect(highRes.status).toBe(201);

    const mediumRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Entrega en 2 días',
        userPriority: 'LOW',
        dueAt: now + 48 * 3_600_000, // 48h -> MEDIUM
      });
    expect(mediumRes.status).toBe(201);

    // Wait microtask flush for PriorityRecalcQueue
    await new Promise((resolve) => setTimeout(resolve, 20));

    const getCritical = await request(app)
      .get(`/api/v1/tasks/${criticalRes.body.task.id}`)
      .set('x-device-id', deviceId);
    expect(getCritical.status).toBe(200);
    expect(getCritical.body.task.aiPriority).toBe('CRITICAL');
    expect(getCritical.body.task.effectivePriority).toBe('CRITICAL');
    expect(getCritical.body.task.priorityScore).toBeGreaterThanOrEqual(90);
    expect(getCritical.body.task.priorityReason).toEqual(expect.any(String));
    expect(getCritical.body.task.priorityComputedAt).toEqual(expect.any(Number));

    const getHigh = await request(app)
      .get(`/api/v1/tasks/${highRes.body.task.id}`)
      .set('x-device-id', deviceId);
    expect(getHigh.body.task.aiPriority).toBe('HIGH');
    expect(getHigh.body.task.effectivePriority).toBe('HIGH');
    expect(getHigh.body.task.priorityScore).toBeGreaterThanOrEqual(70);

    const getMedium = await request(app)
      .get(`/api/v1/tasks/${mediumRes.body.task.id}`)
      .set('x-device-id', deviceId);
    expect(getMedium.body.task.aiPriority).toBe('MEDIUM');
    expect(getMedium.body.task.effectivePriority).toBe('MEDIUM');

    // Filter by CRITICAL works
    const criticalFilter = await request(app)
      .get('/api/v1/tasks?priority=CRITICAL')
      .set('x-device-id', deviceId);
    expect(criticalFilter.status).toBe(200);
    expect(criticalFilter.body.tasks).toHaveLength(1);
    expect(criticalFilter.body.tasks[0].id).toBe(criticalRes.body.task.id);

    // Completing clears aiPriority and resets score to 0
    await request(app)
      .patch(`/api/v1/tasks/${criticalRes.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ completed: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterComplete = await request(app)
      .get(`/api/v1/tasks/${criticalRes.body.task.id}`)
      .set('x-device-id', deviceId);
    expect(afterComplete.body.task.aiPriority).toBeNull();
    expect(afterComplete.body.task.effectivePriority).toBe('LOW');
    expect(afterComplete.body.task.priorityScore).toBe(0);
    expect(afterComplete.body.task.priorityReason).toBeNull();
  });

  it('Fase 6.5A: TaskService.updateTask preserves max(userPriority, aiPriority) on non-priority edits', async () => {
    const app = createApp({ db });
    const now = Date.now();

    const created = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Original',
        userPriority: 'LOW',
        dueAt: now + 2 * 3_600_000, // aiPriority -> CRITICAL
      });
    const taskId = created.body.task.id as string;

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Edit title & description only: effectivePriority must stay CRITICAL
    const titlePatch = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ title: 'Editada', description: 'Nueva descripción' });
    expect(titlePatch.status).toBe(200);
    expect(titlePatch.body.task.userPriority).toBe('LOW');
    expect(titlePatch.body.task.aiPriority).toBe('CRITICAL');
    expect(titlePatch.body.task.effectivePriority).toBe('CRITICAL');

    // Raise userPriority to HIGH while aiPriority is CRITICAL: effectivePriority stays CRITICAL
    const highPatch = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('x-device-id', deviceId)
      .send({ userPriority: 'HIGH' });
    expect(highPatch.status).toBe(200);
    expect(highPatch.body.task.userPriority).toBe('HIGH');
    expect(highPatch.body.task.effectivePriority).toBe('CRITICAL');

    // When dueAt is 48h (aiPriority MEDIUM), raising userPriority to HIGH yields HIGH,
    // and lowering back to LOW keeps MEDIUM
    const medCreated = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Media por fecha',
        userPriority: 'LOW',
        dueAt: now + 48 * 3_600_000,
      });
    const medId = medCreated.body.task.id as string;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const raised = await request(app)
      .patch(`/api/v1/tasks/${medId}`)
      .set('x-device-id', deviceId)
      .send({ userPriority: 'HIGH' });
    expect(raised.body.task.aiPriority).toBe('MEDIUM');
    expect(raised.body.task.effectivePriority).toBe('HIGH');

    const lowered = await request(app)
      .patch(`/api/v1/tasks/${medId}`)
      .set('x-device-id', deviceId)
      .send({ userPriority: 'LOW' });
    expect(lowered.body.task.effectivePriority).toBe('MEDIUM');
  });

  it('computes priority inline in POST/PATCH responses without extra SQLite round-trips and caches filtered queries', async () => {
    const app = createApp({ db });
    const now = Date.now();

    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({
        title: 'Inline priority',
        userPriority: 'LOW',
        dueAt: now + 2 * 3_600_000,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.task.aiPriority).toBe('CRITICAL');
    expect(createRes.body.task.effectivePriority).toBe('CRITICAL');
    expect(createRes.body.task.priorityScore).toBeGreaterThanOrEqual(90);
    expect(createRes.body.task.priorityReason).toEqual(expect.any(String));
    expect(createRes.body.task.priorityComputedAt).toEqual(expect.any(Number));

    const patchRes = await request(app)
      .patch(`/api/v1/tasks/${createRes.body.task.id}`)
      .set('x-device-id', deviceId)
      .send({ dueAt: now + 48 * 3_600_000 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.task.aiPriority).toBe('MEDIUM');
    expect(patchRes.body.task.effectivePriority).toBe('MEDIUM');
    expect(patchRes.body.task.priorityScore).toBeGreaterThanOrEqual(40);

    // Verify filtered query statements are cached and not recompiled on repeat calls
    const prepareSpy = vi.spyOn(db, 'prepare');

    await request(app)
      .get('/api/v1/tasks?status=pending&priority=MEDIUM&sortBy=dueAt')
      .set('x-device-id', deviceId);
    const preparesAfterFirst = prepareSpy.mock.calls.length;
    expect(preparesAfterFirst).toBe(1);

    await request(app)
      .get('/api/v1/tasks?status=pending&priority=MEDIUM&sortBy=dueAt')
      .set('x-device-id', deviceId);
    expect(prepareSpy.mock.calls.length).toBe(preparesAfterFirst);

    prepareSpy.mockRestore();
  });
});
