import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { EventLogRepository } from '../src/repositories/eventLogRepository.js';

describe('Fase 0: Fundamentos del Back-end', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('GET /api/v1/health returns ok status', async () => {
    const app = createApp({ db });
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('GET /api/v1/time returns authoritative serverTimeMs and iso', async () => {
    const app = createApp({ db });
    const before = Date.now();
    const res = await request(app).get('/api/v1/time');
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.serverTimeMs).toBeGreaterThanOrEqual(before);
    expect(res.body.serverTimeMs).toBeLessThanOrEqual(after);
    expect(typeof res.body.iso).toBe('string');
  });

  it('POST /api/v1/auth/device creates a new device user with default preferences and logs event', async () => {
    const app = createApp({ db });
    const res = await request(app).post('/api/v1/auth/device').send({});

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(res.body.user.authProvider).toBe('device');
    expect(res.body.preferences.focusDurationMin).toBe(25);
    expect(res.body.preferences.cyclesBeforeLongBreak).toBe(4);

    const eventRepo = new EventLogRepository(db);
    const events = eventRepo.listByUser(res.body.user.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('USER_REGISTERED');
  });

  it('POST /api/v1/auth/device is idempotent for an existing deviceId', async () => {
    const app = createApp({ db });
    const deviceId = crypto.randomUUID();

    const first = await request(app).post('/api/v1/auth/device').send({ deviceId });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const second = await request(app).post('/api/v1/auth/device').send({ deviceId });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it('POST /api/v1/auth/device rejects non-UUID deviceId', async () => {
    const app = createApp({ db });
    const res = await request(app)
      .post('/api/v1/auth/device')
      .send({ deviceId: 'not-a-valid-uuid' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/auth/me validates identity via x-device-id and Authorization header', async () => {
    const app = createApp({ db });
    const deviceId = crypto.randomUUID();
    const reg = await request(app).post('/api/v1/auth/device').send({ deviceId });

    const viaHeader = await request(app)
      .get('/api/v1/auth/me')
      .set('x-device-id', deviceId);

    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.provider).toBe('device');
    expect(viaHeader.body.user.id).toBe(reg.body.user.id);
    expect(viaHeader.body.user.deviceId).toBe(deviceId);

    const viaAuth = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Device ${deviceId}`);

    expect(viaAuth.status).toBe(200);
    expect(viaAuth.body.user.id).toBe(reg.body.user.id);
  });

  it('GET /api/v1/auth/me returns 401 when missing or unknown deviceId', async () => {
    const app = createApp({ db });

    const missing = await request(app).get('/api/v1/auth/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHORIZED');

    const unknown = await request(app)
      .get('/api/v1/auth/me')
      .set('x-device-id', crypto.randomUUID());
    expect(unknown.status).toBe(401);
  });

  it('EventLogRepository enforces idempotency by eventId', async () => {
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    const userId = reg.body.user.id as string;

    const eventRepo = new EventLogRepository(db);
    const eventId = crypto.randomUUID();

    const first = eventRepo.append({
      eventId,
      userId,
      entityType: 'session',
      entityId: crypto.randomUUID(),
      eventType: 'TEST_EVENT',
      payload: { step: 1 },
    });
    const second = eventRepo.append({
      eventId,
      userId,
      entityType: 'session',
      entityId: crypto.randomUUID(),
      eventType: 'TEST_EVENT',
      payload: { step: 2 },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });
});
