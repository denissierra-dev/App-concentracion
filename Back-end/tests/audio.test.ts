import fs from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { clearAudioCatalogCache } from '../src/services/audioCatalog.js';

describe('Fase 3: Sistema de Audio y Política de Volumen', () => {
  let db: AppDatabase;
  let deviceId: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    deviceId = reg.body.deviceId;
  });

  afterEach(() => {
    db.close();
  });

  it('GET /api/v1/audio/policy requires auth and reflects user volume preferences', async () => {
    const app = createApp({ db });

    const unauth = await request(app).get('/api/v1/audio/policy');
    expect(unauth.status).toBe(401);

    const initial = await request(app)
      .get('/api/v1/audio/policy')
      .set('x-device-id', deviceId);
    expect(initial.status).toBe(200);
    expect(initial.body.volumePolicy).toEqual({
      focus: 0.7,
      short_break: 0.3,
      long_break: 0.3,
    });

    await request(app)
      .patch('/api/v1/preferences')
      .set('x-device-id', deviceId)
      .send({ volumeFocus: 0.9, volumeBreak: 0.15 });

    const updated = await request(app)
      .get('/api/v1/audio/policy')
      .set('x-device-id', deviceId);
    expect(updated.status).toBe(200);
    expect(updated.body.volumePolicy).toEqual({
      focus: 0.9,
      short_break: 0.15,
      long_break: 0.15,
    });
  });

  it('GET /api/v1/audio/tracks lists available tracks with stream URLs and volumePolicy', async () => {
    const app = createApp({ db });
    const res = await request(app)
      .get('/api/v1/audio/tracks')
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.tracks.length).toBeGreaterThanOrEqual(3);
    expect(res.body.tracks[0]).toMatchObject({
      id: 'rain-ambient',
      mimeType: 'audio/wav',
      streamUrl: '/api/v1/audio/tracks/rain-ambient/stream',
    });
    expect(res.body.tracks[0].sizeBytes).toBeGreaterThan(44);
    expect(res.body.volumePolicy.focus).toBe(0.7);
  });

  it('GET /api/v1/audio/tracks/:id/stream serves full WAV and supports HTTP 206 Range requests', async () => {
    const app = createApp({ db });

    const full = await request(app)
      .get('/api/v1/audio/tracks/rain-ambient/stream')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const bodyBuf = full.body as Buffer;
    expect(bodyBuf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bodyBuf.subarray(8, 12).toString('ascii')).toBe('WAVE');

    const partial = await request(app)
      .get('/api/v1/audio/tracks/rain-ambient/stream')
      .set('Range', 'bytes=0-1023')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-1023/${bodyBuf.length}`);
    expect(Number(partial.headers['content-length'])).toBe(1024);
    expect((partial.body as Buffer).length).toBe(1024);
    expect((partial.body as Buffer).equals(bodyBuf.subarray(0, 1024))).toBe(true);

    const openEnded = await request(app)
      .get('/api/v1/audio/tracks/brown-noise/stream')
      .set('Range', 'bytes=44-');
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers['content-range']).toMatch(/^bytes 44-\d+\/\d+$/);
  });

  it('GET /api/v1/audio/tracks/:id/stream returns 416 on invalid range and 404 on unknown/traversal IDs', async () => {
    const app = createApp({ db });

    const outOfRange = await request(app)
      .get('/api/v1/audio/tracks/focus-drone/stream')
      .set('Range', 'bytes=9999999-10000000');
    expect(outOfRange.status).toBe(416);
    expect(outOfRange.headers['cache-control']).toContain('no-store');
    expect(outOfRange.headers['content-type']).toContain('application/json');

    const unknown = await request(app).get('/api/v1/audio/tracks/non-existent/stream');
    expect(unknown.status).toBe(404);

    const traversal = await request(app).get('/api/v1/audio/tracks/..%2F..%2Fpackage.json/stream');
    expect(traversal.status).toBe(404);
  });

  it('caches resolved audio catalog metadata in memory without repeating disk syscalls', async () => {
    clearAudioCatalogCache();
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const statSpy = vi.spyOn(fs, 'statSync');

    try {
      const app = createApp({ db });

      const firstList = await request(app)
        .get('/api/v1/audio/tracks')
        .set('x-device-id', deviceId);
      expect(firstList.status).toBe(200);
      expect(realpathSpy.mock.calls.length).toBeGreaterThan(0);
      expect(statSpy.mock.calls.length).toBeGreaterThan(0);

      realpathSpy.mockClear();
      statSpy.mockClear();

      const secondList = await request(app)
        .get('/api/v1/audio/tracks')
        .set('x-device-id', deviceId);
      expect(secondList.status).toBe(200);

      const streamRes = await request(app)
        .get('/api/v1/audio/tracks/rain-ambient/stream')
        .set('Range', 'bytes=0-63');
      expect(streamRes.status).toBe(206);

      expect(realpathSpy).not.toHaveBeenCalled();
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it('destroys audio ReadStream when client closes connection early and guards res.headersSent in errorHandler', async () => {
    const app = createApp({ db });
    const origCreateReadStream = fs.createReadStream.bind(fs);
    let capturedStream: fs.ReadStream | null = null;

    const createStreamSpy = vi
      .spyOn(fs, 'createReadStream')
      .mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
        const stream = origCreateReadStream(...args);
        capturedStream = stream;
        return stream;
      }) as typeof fs.createReadStream);

    try {
      await request(app)
        .get('/api/v1/audio/tracks/rain-ambient/stream')
        .set('Range', 'bytes=0-127');
      expect(capturedStream).not.toBeNull();
      expect((capturedStream as unknown as fs.ReadStream).destroyed).toBe(true);
    } finally {
      createStreamSpy.mockRestore();
    }

    // Verify errorHandler delegates to next(err) when headersSent is true instead of calling res.status()
    const statusSpy = vi.fn();
    const nextSpy = vi.fn();
    const fakeRes = {
      headersSent: true,
      status: statusSpy,
    } as unknown as Response;
    const err = new Error('Mid-stream failure');

    errorHandler(err, {} as Request, fakeRes, nextSpy as unknown as NextFunction);
    expect(nextSpy).toHaveBeenCalledWith(err);
    expect(statusSpy).not.toHaveBeenCalled();
  });
});
