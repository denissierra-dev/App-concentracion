import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { GoogleOidcVerifier } from '../src/auth/googleVerifier.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { resolveAudioTrack } from '../src/services/audioCatalog.js';
import express from 'express';

function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid = 'sec-key-1'
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${h}.${p}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(privateKey).toString('base64url')}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Security Hardening & Vulnerability Regression Suite', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('enforces strict CORS allowlist (never defaults to *) and rejects wildcard in production', async () => {
    const app = createApp({ db });

    const allowed = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const blocked = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(blocked.status).toBe(200);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createApp({ db, corsOrigin: '*' })).toThrow(/disallowed in production/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('applies strict security headers and no-store caching on API responses while preserving audio stream cache', async () => {
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});

    expect(reg.headers['x-frame-options']).toBe('DENY');
    expect(reg.headers['x-content-type-options']).toBe('nosniff');
    expect(reg.headers['permissions-policy']).toContain('camera=()');
    expect(reg.headers['cache-control']).toContain('no-store');
    expect(reg.headers['x-powered-by']).toBeUndefined();

    const audioRes = await request(app).get('/api/v1/audio/tracks/rain-ambient/stream');
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('handles malformed JSON cleanly with 400 and strips prototype-pollution keys', async () => {
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    const deviceId = reg.body.deviceId as string;

    const malformed = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');

    const polluted = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .set('Content-Type', 'application/json')
      .send('{"title":"Safe task","__proto__":{"isAdmin":true},"constructor":{"x":1}}');
    expect(polluted.status).toBe(201);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it('rejects nil UUID and canonicalizes uppercase UUIDs to lowercase across auth and API', async () => {
    const app = createApp({ db });

    const nilRes = await request(app)
      .post('/api/v1/auth/device')
      .send({ deviceId: '00000000-0000-0000-0000-000000000000' });
    expect(nilRes.status).toBe(400);
    expect(nilRes.body.error.code).toBe('VALIDATION_ERROR');

    const upperUuid = crypto.randomUUID().toUpperCase();
    const reg = await request(app)
      .post('/api/v1/auth/device')
      .send({ deviceId: upperUuid });
    expect(reg.status).toBe(201);
    expect(reg.body.deviceId).toBe(upperUuid.toLowerCase());

    const meUpper = await request(app)
      .get('/api/v1/auth/me')
      .set('x-device-id', upperUuid);
    expect(meUpper.status).toBe(200);
    expect(meUpper.body.user.deviceId).toBe(upperUuid.toLowerCase());

    const nilUuid = '00000000-0000-0000-0000-000000000000';
    const validDeviceId = reg.body.deviceId as string;

    // Nil UUID rejected by DeviceIdAuthProvider (401)
    expect(
      (await request(app).get('/api/v1/auth/me').set('x-device-id', nilUuid)).status
    ).toBe(401);

    // Nil UUID rejected across sessions, tasks, preferences, sync, search history (400)
    expect(
      (
        await request(app)
          .post('/api/v1/sessions')
          .set('x-device-id', validDeviceId)
          .send({ sessionId: nilUuid })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/v1/tasks')
          .set('x-device-id', validDeviceId)
          .send({ id: nilUuid, title: 'Nil task' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/v1/preferences')
          .set('x-device-id', validDeviceId)
          .send({ focusDurationMin: 30, eventId: nilUuid })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/v1/sync')
          .set('x-device-id', validDeviceId)
          .send({
            events: [
              {
                eventId: nilUuid,
                entityType: 'task',
                entityId: crypto.randomUUID(),
                eventType: 'TASK_CREATED',
                payload: { title: 'Nil event' },
              },
            ],
          })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .delete(`/api/v1/search/history/${nilUuid}`)
          .set('x-device-id', validDeviceId)
      ).status
    ).toBe(400);
  });

  it('rejects XSS markup, unsafe URI schemes, and control/bidi chars on Back-end endpoints', async () => {
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    const deviceId = reg.body.deviceId as string;

    expect(
      (
        await request(app)
          .post('/api/v1/tasks')
          .set('x-device-id', deviceId)
          .send({ title: '<script>alert(1)</script>' })
      ).status
    ).toBe(400);

    expect(
      (
        await request(app)
          .post('/api/v1/tasks')
          .set('x-device-id', deviceId)
          .send({ title: 'Valid', description: 'Check javascript:alert(1)' })
      ).status
    ).toBe(400);

    expect(
      (
        await request(app)
          .post('/api/v1/tasks')
          .set('x-device-id', deviceId)
          .send({ title: 'Spoof\u202Etxt.exe' })
      ).status
    ).toBe(400);

    // Multiline task descriptions with safe \n and Windows \r\n remain allowed (normalized to \n)
    const multiline = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Multiline task', description: 'Line 1\nLine 2' });
    expect(multiline.status).toBe(201);
    expect(multiline.body.task.description).toBe('Line 1\nLine 2');

    const crlfMultiline = await request(app)
      .post('/api/v1/tasks')
      .set('x-device-id', deviceId)
      .send({ title: 'Windows CRLF task', description: 'Line 1\r\nLine 2\r\nLine 3' });
    expect(crlfMultiline.status).toBe(201);
    expect(crlfMultiline.body.task.description).toBe('Line 1\nLine 2\nLine 3');

    // Lone CR (\r without \n) remains blocked
    expect(
      (
        await request(app)
          .post('/api/v1/tasks')
          .set('x-device-id', deviceId)
          .send({ title: 'Lone CR', description: 'Line 1\rSpoof' })
      ).status
    ).toBe(400);

    expect(
      (
        await request(app)
          .get('/api/v1/search')
          .query({ q: '<img src=x onerror=alert(1)>' })
          .set('x-device-id', deviceId)
      ).status
    ).toBe(400);
  });

  it('prevents entity-encoded tag re-introduction, bidi overrides, and oversized responses in SearchService', async () => {
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      return jsonResponse({
        query: {
          search: [
            {
              pageid: 101,
              title: 'Safe &lt;script&gt;alert(1)&lt;/script&gt; Title&#x202E;&#0;',
              snippet: '<b>&lt;img src=x onerror=alert(1)&gt;</b> Clean snippet &amp; text',
            },
          ],
        },
      });
    });

    const app = createApp({ db, searchFetchImpl: mockFetch });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    const deviceId = reg.body.deviceId as string;

    const res = await request(app)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'safe query' })
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.results[0].title).toBe('Safe alert(1) Title');
    expect(res.body.results[0].snippet).toBe('Clean snippet & text');

    // Reject oversized upstream body (>2MB)
    const hugeFetch = vi.fn<typeof fetch>(async () =>
      new Response('x'.repeat(2 * 1024 * 1024 + 100), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const hugeApp = createApp({ db, searchFetchImpl: hugeFetch });
    const hugeRes = await request(hugeApp)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'huge' })
      .set('x-device-id', deviceId);
    expect(hugeRes.status).toBe(502);
    expect(hugeRes.body.error.code).toBe('SEARCH_UPSTREAM_ERROR');
  });

  it('blocks symlinks escaping audioDir in resolveAudioTrack', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-audio-sec-'));
    try {
      const audioDir = path.join(tmpRoot, 'audio');
      const outsideFile = path.join(tmpRoot, 'secret.txt');
      fs.mkdirSync(audioDir);
      fs.writeFileSync(outsideFile, 'secret');
      fs.symlinkSync(outsideFile, path.join(audioDir, 'rain-ambient.wav'));

      expect(resolveAudioTrack(audioDir, 'rain-ambient')).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enforces rate limiting on /api/v1/auth/device when enabled', async () => {
    const app = createApp({ db, enableRateLimit: true });

    for (let i = 0; i < 20; i++) {
      const res = await request(app).post('/api/v1/auth/device').send({});
      expect(res.status).toBe(201);
    }

    const limited = await request(app).post('/api/v1/auth/device').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('sanitizes 404 route reflection', async () => {
    const app = createApp({ db });
    const res = await request(app).get('/api/v1/nonexistent?secret=123');
    expect(res.status).toBe(404);
    expect(res.body.error.message).not.toContain('secret=123');
  });

  it('blocks cross-site/untrusted-origin CSRF on cookie-authenticated mutations while allowing trusted origin', async () => {
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/register').send({
      username: 'csrf_tester',
      password: 'StrongPassword123!',
    });
    const sessionCookie = (reg.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    expect(sessionCookie).toContain('dw_session=');

    const badOrigin = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', sessionCookie)
      .set('Origin', 'https://evil.example')
      .send({ title: 'CSRF task' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    const crossSiteFetch = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', sessionCookie)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ title: 'CSRF task' });
    expect(crossSiteFetch.status).toBe(403);
    expect(crossSiteFetch.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    // Sibling subdomain (Sec-Fetch-Site: same-site) without Origin/Referer must be blocked
    const sameSiteNoOrigin = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', sessionCookie)
      .set('Sec-Fetch-Site', 'same-site')
      .send({ title: 'Sibling CSRF task' });
    expect(sameSiteNoOrigin.status).toBe(403);
    expect(sameSiteNoOrigin.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    // Sec-Fetch-Site: same-site WITH trusted Origin (e.g. localhost:5173 -> localhost:3001) is allowed
    const sameSiteTrustedOrigin = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', sessionCookie)
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'http://localhost:5173')
      .send({ title: 'Legitimate same-site task' });
    expect(sameSiteTrustedOrigin.status).toBe(201);

    const allowedOrigin = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', sessionCookie)
      .set('Origin', 'http://localhost:5173')
      .send({ title: 'Legitimate task' });
    expect(allowedOrigin.status).toBe(201);
  });

  it('prevents email verification elevation and silent Google sub overwrite on /auth/link/google', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const clientId = 'sec-google-client.apps.googleusercontent.com';

    const mockFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'sec-key-1', alg: 'RS256', use: 'sig' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const verifier = new GoogleOidcVerifier({
      clientId,
      clientSecret: 'test-secret',
      fetchImpl: mockFetch,
    });
    const app = createApp({ db, googleVerifier: verifier });

    // User registers with unverified victim email
    const reg = await request(app).post('/api/v1/auth/register').send({
      username: 'email_test_user',
      password: 'StrongPassword123!',
      email: 'victim@example.com',
    });
    expect(reg.body.user.emailVerified).toBe(false);

    // Links an unrelated verified Google email -> victim@example.com must NOT become emailVerified: true
    const googleA = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-alpha',
        email: 'attacker@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey
    );
    const linkRes = await request(app)
      .post('/api/v1/auth/link/google')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ idToken: googleA });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.user.email).toBe('victim@example.com');
    expect(linkRes.body.user.emailVerified).toBe(false);

    // Attempting to silently overwrite linked googleSub with another Google account -> 409
    const googleB = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-beta',
        email: 'other@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey
    );
    const overwriteRes = await request(app)
      .post('/api/v1/auth/link/google')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ idToken: googleB });
    expect(overwriteRes.status).toBe(409);
    expect(overwriteRes.body.error.code).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');
  });

  it('rejects disallowed OAuth redirectUri origins and multi-audience tokens without matching azp', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const clientId = 'sec-google-client.apps.googleusercontent.com';

    const mockFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'sec-key-1', alg: 'RS256', use: 'sig' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const verifier = new GoogleOidcVerifier({
      clientId,
      clientSecret: 'test-secret',
      fetchImpl: mockFetch,
    });
    const app = createApp({ db, googleVerifier: verifier });

    const badRedirect = await request(app).post('/api/v1/auth/google').send({
      code: 'oauth-code-12345',
      redirectUri: 'https://evil.example/auth/callback',
      codeVerifier: 'verifier_1234567890abcdef',
    });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.body.error.code).toBe('VALIDATION_ERROR');

    const multiAudWrongAzp = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: [clientId, 'other-client-id'],
        azp: 'other-client-id',
        sub: 'google-sub-multi',
        email: 'user@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey
    );
    await expect(verifier.verifyIdToken(multiAudWrongAzp)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('caps active auth_sessions per user at 50', async () => {
    const app = createApp({ db });
    await request(app).post('/api/v1/auth/register').send({
      username: 'session_cap_user',
      password: 'StrongPassword123!',
    });

    let latestToken = '';
    for (let i = 0; i < 52; i++) {
      const login = await request(app).post('/api/v1/auth/login').send({
        identifier: 'session_cap_user',
        password: 'StrongPassword123!',
      });
      latestToken = login.body.token;
    }

    const sessionsRes = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${latestToken}`);
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions).toHaveLength(50);
  }, 15_000);

  it('respects trustProxy setting for X-Forwarded-For rate limiting', async () => {
    // Default trustProxy=false ignores spoofed X-Forwarded-For headers
    const directApp = createApp({ db, enableRateLimit: true });
    for (let i = 0; i < 20; i++) {
      const res = await request(directApp)
        .post('/api/v1/auth/device')
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .send({});
      expect(res.status).toBe(201);
    }
    const blockedSpoof = await request(directApp)
      .post('/api/v1/auth/device')
      .set('X-Forwarded-For', '203.0.113.250')
      .send({});
    expect(blockedSpoof.status).toBe(429);

    // With trustProxy=1 behind a reverse proxy, each forwarded client IP gets its own bucket
    const proxyApp = createApp({ db, enableRateLimit: true, trustProxy: 1 });
    for (let i = 0; i < 20; i++) {
      const res = await request(proxyApp)
        .post('/api/v1/auth/device')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({});
      expect(res.status).toBe(201);
    }
    const clientALimited = await request(proxyApp)
      .post('/api/v1/auth/device')
      .set('X-Forwarded-For', '198.51.100.10')
      .send({});
    expect(clientALimited.status).toBe(429);

    const clientBAllowed = await request(proxyApp)
      .post('/api/v1/auth/device')
      .set('X-Forwarded-For', '198.51.100.20')
      .send({});
    expect(clientBAllowed.status).toBe(201);
  });

  it('uses a dedicated 1200/min bucket for audio streaming without consuming api-global budget', async () => {
    const app = createApp({ db, enableRateLimit: true });

    const baselineHealth = await request(app).get('/api/v1/health');
    expect(baselineHealth.status).toBe(200);
    expect(baselineHealth.headers['x-ratelimit-limit']).toBe('180');
    const remainingBeforeAudio = Number(baselineHealth.headers['x-ratelimit-remaining']);

    for (let i = 0; i < 5; i++) {
      const streamRes = await request(app)
        .get('/api/v1/audio/tracks/rain-ambient/stream')
        .set('Range', 'bytes=0-63');
      expect(streamRes.status).toBe(206);
      expect(streamRes.headers['x-ratelimit-limit']).toBe('1200');
    }

    const afterAudioHealth = await request(app).get('/api/v1/health');
    expect(afterAudioHealth.status).toBe(200);
    expect(Number(afterAudioHealth.headers['x-ratelimit-remaining'])).toBe(
      remainingBeforeAudio - 1
    );
  });

  it('preserves active rate-limit buckets under distinct-IP floods and purges expired buckets first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'));

      const testApp = express();
      testApp.use(
        createRateLimiter({
          keyPrefix: 'flood-test',
          windowMs: 60_000,
          maxRequests: 2,
          maxBuckets: 2,
          keyGenerator: (req) => req.header('x-client-key') ?? 'anon',
        })
      );
      testApp.get('/ping', (_req, res) => res.json({ ok: true }));

      // Client A exhausts its limit (2/2) -> 3rd request is 429
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-A')).status
      ).toBe(200);
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-A')).status
      ).toBe(200);
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-A')).status
      ).toBe(429);

      // Client B uses 1/2 (bucket table is now at maxBuckets = 2 with 2 active windows)
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-B')).status
      ).toBe(200);

      // Flood of distinct keys while A & B are active must NOT evict/reset Client A's active bucket
      for (let i = 0; i < 5; i++) {
        const overflow = await request(testApp)
          .get('/ping')
          .set('x-client-key', `flood-ip-${i}`);
        expect(overflow.status).toBe(429);
      }

      // Client A is STILL rate-limited (was not FIFO-evicted)
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-A')).status
      ).toBe(429);
      // Client B still has its remaining 1 request in its active bucket
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-B')).status
      ).toBe(200);

      // Once the window expires, expired buckets are purged and new keys succeed
      vi.advanceTimersByTime(61_000);
      expect(
        (await request(testApp).get('/ping').set('x-client-key', 'client-C')).status
      ).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
