import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleOidcVerifier } from '../src/auth/googleVerifier.js';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { AuthSessionRepository } from '../src/repositories/authSessionRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';

function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid = 'test-key-1'
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${h}.${p}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const sig = signer.sign(privateKey).toString('base64url');
  return `${data}.${sig}`;
}

describe('Autenticación: Usuario/Contraseña, Google Sign-In y Sesiones Persistentes', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('exposes auth providers info without leaking clientSecret', async () => {
    const appNoGoogle = createApp({ db });
    const res1 = await request(appNoGoogle).get('/api/v1/auth/providers');
    expect(res1.status).toBe(200);
    expect(res1.body.providers).toEqual({
      password: { enabled: true },
      google: { enabled: false, codeFlowEnabled: false, clientId: null },
      device: { enabled: true },
    });

    const appWithGoogle = createApp({
      db,
      googleAuthConfig: {
        clientId: 'google-client-123.apps.googleusercontent.com',
        clientSecret: 'super-secret-do-not-leak',
      },
    });
    const res2 = await request(appWithGoogle).get('/api/v1/auth/providers');
    expect(res2.status).toBe(200);
    expect(res2.body.providers.google).toEqual({
      enabled: true,
      codeFlowEnabled: true,
      clientId: 'google-client-123.apps.googleusercontent.com',
    });
    expect(JSON.stringify(res2.body)).not.toContain('super-secret-do-not-leak');
  });

  it('registers and logs in with username/email + password, supports Bearer & HttpOnly cookie, and validates rules', async () => {
    const app = createApp({ db });

    // Register with rememberMe = false (short-lived session cookie without Max-Age)
    const reg = await request(app).post('/api/v1/auth/register').send({
      username: 'Denis_Dev',
      password: 'StrongPassword123!',
      email: 'Denis@Example.com',
      displayName: 'Denis',
      rememberMe: false,
      deviceLabel: 'Laptop Linux',
    });

    expect(reg.status).toBe(201);
    expect(reg.body.created).toBe(true);
    expect(reg.body.provider).toBe('password');
    expect(reg.body.tokenType).toBe('Bearer');
    expect(reg.body.rememberMe).toBe(false);
    expect(reg.body.session.persistent).toBe(false);
    expect(reg.body.user).toMatchObject({
      authProvider: 'password',
      username: 'Denis_Dev',
      email: 'denis@example.com',
      displayName: 'Denis',
      hasPassword: true,
      hasGoogleLinked: false,
    });
    expect(JSON.stringify(reg.body)).not.toContain('passwordHash');
    expect(JSON.stringify(reg.body)).not.toContain('StrongPassword123!');

    const regCookie = reg.headers['set-cookie']?.[0] ?? '';
    expect(regCookie).toContain('dw_session=');
    expect(regCookie).toContain('HttpOnly');
    expect(regCookie).not.toContain('Max-Age=');

    // Duplicate username (case-insensitive) -> 409 USERNAME_ALREADY_EXISTS
    const dupUser = await request(app).post('/api/v1/auth/register').send({
      username: 'denis_dev',
      password: 'AnotherPassword123!',
    });
    expect(dupUser.status).toBe(409);
    expect(dupUser.body.error.code).toBe('USERNAME_ALREADY_EXISTS');

    // Duplicate email -> 409 EMAIL_ALREADY_EXISTS
    const dupEmail = await request(app).post('/api/v1/auth/register').send({
      username: 'other_user',
      email: 'denis@example.com',
      password: 'AnotherPassword123!',
    });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_ALREADY_EXISTS');

    // Weak/short password -> 400
    const weakPw = await request(app).post('/api/v1/auth/register').send({
      username: 'valid_name',
      password: '123',
    });
    expect(weakPw.status).toBe(400);

    // Login using email (case-insensitive) + rememberMe = true (persistent 30d session)
    const login = await request(app).post('/api/v1/auth/login').send({
      identifier: 'DENIS@example.com',
      password: 'StrongPassword123!',
      rememberMe: true,
      deviceLabel: 'Work Browser',
    });

    expect(login.status).toBe(200);
    expect(login.body.rememberMe).toBe(true);
    expect(login.body.session.persistent).toBe(true);
    expect(login.body.expiresAt - Date.now()).toBeGreaterThan(20 * 86_400_000);

    const persistentCookie = login.headers['set-cookie']?.[0] ?? '';
    expect(persistentCookie).toContain('dw_session=');
    expect(persistentCookie).toContain('Max-Age=');

    // Authenticate protected endpoints using Bearer token
    const meBearer = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(meBearer.status).toBe(200);
    expect(meBearer.body.provider).toBe('password');
    expect(meBearer.body.user.username).toBe('Denis_Dev');
    expect(meBearer.body.session.persistent).toBe(true);

    // Authenticate protected task endpoint using HttpOnly cookie
    const createTask = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', persistentCookie.split(';')[0]!)
      .send({ title: 'Task authenticated via session cookie' });
    expect(createTask.status).toBe(201);

    // Wrong password -> 401 INVALID_CREDENTIALS
    const badLogin = await request(app).post('/api/v1/auth/login').send({
      identifier: 'Denis_Dev',
      password: 'WrongPassword123!',
    });
    expect(badLogin.status).toBe(401);
    expect(badLogin.body.error.code).toBe('INVALID_CREDENTIALS');

    // Invalid Bearer token must NOT fall back to x-device-id
    const legacyDevice = await request(app).post('/api/v1/auth/device').send({});
    const mixedInvalid = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid-token-1234567890')
      .set('x-device-id', legacyDevice.body.deviceId);
    expect(mixedInvalid.status).toBe(401);
  });

  it('lists, revokes individual saved sessions, and logs out current or all sessions', async () => {
    const app = createApp({ db });

    const s1 = await request(app).post('/api/v1/auth/register').send({
      username: 'multi_session',
      password: 'Password1234!',
      rememberMe: true,
      deviceLabel: 'Session 1',
    });
    const s2 = await request(app).post('/api/v1/auth/login').send({
      identifier: 'multi_session',
      password: 'Password1234!',
      rememberMe: false,
      deviceLabel: 'Session 2',
    });

    const list = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${s2.body.token}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    const currentEntry = list.body.sessions.find((s: { isCurrent: boolean }) => s.isCurrent);
    expect(currentEntry.id).toBe(s2.body.session.id);

    // Other user cannot revoke our session
    const other = await request(app).post('/api/v1/auth/register').send({
      username: 'other_account',
      password: 'Password1234!',
    });
    const crossRevoke = await request(app)
      .delete(`/api/v1/auth/sessions/${s1.body.session.id}`)
      .set('Authorization', `Bearer ${other.body.token}`);
    expect(crossRevoke.status).toBe(404);

    // Revoke session 1 from session 2
    const revokeOne = await request(app)
      .delete(`/api/v1/auth/sessions/${s1.body.session.id}`)
      .set('Authorization', `Bearer ${s2.body.token}`);
    expect(revokeOne.status).toBe(200);

    const checkRevoked = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${s1.body.token}`);
    expect(checkRevoked.status).toBe(401);

    // Session 2 still works, then logout-all revokes it
    const s3 = await request(app).post('/api/v1/auth/login').send({
      identifier: 'multi_session',
      password: 'Password1234!',
      rememberMe: true,
    });
    const logoutAll = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${s2.body.token}`);
    expect(logoutAll.status).toBe(200);
    expect(logoutAll.body.revokedCount).toBe(2);
    expect(logoutAll.headers['set-cookie']?.[0]).toContain('Max-Age=0');

    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${s3.body.token}`))
        .status
    ).toBe(401);
  });

  it('verifies Google RS256 ID tokens & OAuth code flow, persists Google sessions, and supports account linking', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const clientId = 'test-google-client-id.apps.googleusercontent.com';

    const validClaims = {
      iss: 'https://accounts.google.com',
      aud: clientId,
      sub: 'google-sub-10001',
      email: 'GoogleUser@gmail.com',
      email_verified: true,
      name: 'Google User',
      picture: 'https://lh3.googleusercontent.com/a/avatar',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const validIdToken = signRs256Jwt(validClaims, privateKey, 'kid-1');

    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
          }
        );
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: validIdToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const verifier = new GoogleOidcVerifier({
      clientId,
      clientSecret: 'test-client-secret',
      fetchImpl: mockFetch,
    });
    const app = createApp({ db, googleVerifier: verifier });

    // First Google sign-in via idToken (persistent by default)
    const g1 = await request(app).post('/api/v1/auth/google').send({
      idToken: validIdToken,
      deviceLabel: 'Chrome Google',
    });
    expect(g1.status).toBe(201);
    expect(g1.body.created).toBe(true);
    expect(g1.body.provider).toBe('google');
    expect(g1.body.rememberMe).toBe(true);
    expect(g1.body.session.persistent).toBe(true);
    expect(g1.body.user).toMatchObject({
      authProvider: 'google',
      email: 'googleuser@gmail.com',
      emailVerified: true,
      displayName: 'Google User',
      hasGoogleLinked: true,
      hasPassword: false,
    });

    // Second Google sign-in via OAuth authorization code recovers the same user
    const g2 = await request(app).post('/api/v1/auth/google').send({
      code: 'oauth-auth-code-xyz',
      redirectUri: 'http://localhost:5173/auth/callback',
      codeVerifier: 'pkce-verifier-1234567890',
    });
    expect(g2.status).toBe(200);
    expect(g2.body.created).toBe(false);
    expect(g2.body.user.id).toBe(g1.body.user.id);

    // Tampered token, expired token, wrong audience -> 401 INVALID_GOOGLE_TOKEN
    const tampered = `${validIdToken.slice(0, -4)}AAAA`;
    expect(
      (await request(app).post('/api/v1/auth/google').send({ idToken: tampered })).status
    ).toBe(401);

    const expiredToken = signRs256Jwt(
      { ...validClaims, exp: Math.floor(Date.now() / 1000) - 300 },
      privateKey,
      'kid-1'
    );
    expect(
      (await request(app).post('/api/v1/auth/google').send({ idToken: expiredToken })).status
    ).toBe(401);

    const wrongAudToken = signRs256Jwt({ ...validClaims, aud: 'wrong-client' }, privateKey, 'kid-1');
    expect(
      (await request(app).post('/api/v1/auth/google').send({ idToken: wrongAudToken })).status
    ).toBe(401);

    // Unverified password account claiming victim's email must NOT auto-link or hijack
    const pwUser = await request(app).post('/api/v1/auth/register').send({
      username: 'pw_account',
      password: 'Password1234!',
      email: 'second.google@gmail.com',
    });
    const secondGoogleToken = signRs256Jwt(
      {
        ...validClaims,
        sub: 'google-sub-20002',
        email: 'second.google@gmail.com',
      },
      privateKey,
      'kid-1'
    );
    const gSeparate = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: secondGoogleToken });
    expect(gSeparate.status).toBe(201);
    expect(gSeparate.body.user.id).not.toBe(pwUser.body.user.id);

    // Explicit link of an unlinked Google account to an authenticated password user works
    const thirdGoogleToken = signRs256Jwt(
      {
        ...validClaims,
        sub: 'google-sub-30003',
        email: 'linked.google@gmail.com',
      },
      privateKey,
      'kid-1'
    );
    const linked = await request(app)
      .post('/api/v1/auth/link/google')
      .set('Authorization', `Bearer ${pwUser.body.token}`)
      .send({ idToken: thirdGoogleToken });
    expect(linked.status).toBe(200);
    expect(linked.body.linked).toBe(true);
    expect(linked.body.user.hasGoogleLinked).toBe(true);

    // Linking a Google sub already owned by someone else -> 409 GOOGLE_ACCOUNT_ALREADY_LINKED
    const conflictLink = await request(app)
      .post('/api/v1/auth/link/google')
      .set('Authorization', `Bearer ${pwUser.body.token}`)
      .send({ idToken: validIdToken });
    expect(conflictLink.status).toBe(409);
    expect(conflictLink.body.error.code).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');

    // Unconfigured Google endpoint -> 503 GOOGLE_AUTH_UNCONFIGURED
    const appNoGoogle = createApp({ db });
    const unconfigured = await request(appNoGoogle)
      .post('/api/v1/auth/google')
      .send({ idToken: validIdToken });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe('GOOGLE_AUTH_UNCONFIGURED');
  });

  it('migrates legacy Phase 0 users table seamlessly on existing SQLite files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-auth-migrate-'));
    const dbPath = path.join(tmpDir, 'legacy.db');

    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          auth_provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(auth_provider, external_id)
        );
      `);
      legacy.close();

      const migratedDb = createDatabase(dbPath);
      try {
        const app = createApp({ db: migratedDb });
        const reg = await request(app).post('/api/v1/auth/register').send({
          username: 'migrated_user',
          password: 'Password1234!',
          rememberMe: true,
        });
        expect(reg.status).toBe(201);
        expect(reg.body.user.username).toBe('migrated_user');
      } finally {
        migratedDb.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prevents silent google_sub overwrite on recycled verified email and returns 409 on password email collision when linking Google', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const clientId = 'sec-overwrite-client.apps.googleusercontent.com';

    const mockFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } }
      )
    );
    const verifier = new GoogleOidcVerifier({ clientId, fetchImpl: mockFetch });
    const app = createApp({ db, googleVerifier: verifier });

    // 1. Original Google user signs in with sub-original + verified email
    const tokenOriginal = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-original',
        email: 'recycled@company.com',
        email_verified: true,
        name: 'Original Owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
      'kid-1'
    );
    const firstSignIn = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: tokenOriginal });
    expect(firstSignIn.status).toBe(201);
    const originalUserId = firstSignIn.body.user.id as string;

    // 2. Another Google identity (different sub) with the same verified email must NOT hijack/overwrite
    const tokenRecycled = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-recycled',
        email: 'recycled@company.com',
        email_verified: true,
        name: 'New Employee',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
      'kid-1'
    );
    const secondSignIn = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: tokenRecycled });
    expect(secondSignIn.status).toBe(201);
    expect(secondSignIn.body.user.id).not.toBe(originalUserId);

    // Original sub still owns the original account intact
    const userRepo = new UserRepository(db);
    expect(userRepo.findByGoogleSub('google-sub-original')?.id).toBe(originalUserId);
    expect(userRepo.findByGoogleSub('google-sub-recycled')?.id).toBe(secondSignIn.body.user.id);

    // 3. Password user B (email=NULL) linking a Google account whose email belongs to password user A -> 409 EMAIL_ALREADY_EXISTS (not 500)
    const userA = await request(app).post('/api/v1/auth/register').send({
      username: 'pw_user_a',
      password: 'Password1234!',
      email: 'taken@example.com',
    });
    expect(userA.status).toBe(201);

    const userB = await request(app).post('/api/v1/auth/register').send({
      username: 'pw_user_b',
      password: 'Password1234!',
    });
    expect(userB.status).toBe(201);
    expect(userB.body.user.email).toBeNull();

    const googleTakenEmail = signRs256Jwt(
      {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-email-collision',
        email: 'taken@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
      'kid-1'
    );
    const linkConflict = await request(app)
      .post('/api/v1/auth/link/google')
      .set('Authorization', `Bearer ${userB.body.token}`)
      .send({ idToken: googleTakenEmail });
    expect(linkConflict.status).toBe(409);
    expect(linkConflict.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(userRepo.findById(userB.body.user.id)?.googleSub).toBeNull();
  });

  it('enforces JWKS refresh cooldown, single-flight deduplication, and streaming timeout/size caps in GoogleOidcVerifier', async () => {
    const key1 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key2 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk1 = key1.publicKey.export({ format: 'jwk' });
    const jwk2 = key2.publicKey.export({ format: 'jwk' });
    const clientId = 'jwks-cooldown-client.apps.googleusercontent.com';

    let rotated = false;
    let jwksFetchCount = 0;
    const mockFetch = vi.fn<typeof fetch>(async () => {
      jwksFetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      const keys = rotated
        ? [
            { ...jwk1, kid: 'kid-1', alg: 'RS256', use: 'sig' },
            { ...jwk2, kid: 'kid-2', alg: 'RS256', use: 'sig' },
          ]
        : [{ ...jwk1, kid: 'kid-1', alg: 'RS256', use: 'sig' }];
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
      });
    });

    const verifier = new GoogleOidcVerifier({
      clientId,
      jwksRefreshCooldownMs: 60,
      fetchImpl: mockFetch,
    });

    const makeToken = (kid: string, privateKey: crypto.KeyObject) =>
      signRs256Jwt(
        {
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: 'sub-jwks',
          email: 'jwks@example.com',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        privateKey,
        kid
      );

    // Concurrent cold-cache verifications deduplicate into a SINGLE upstream JWKS fetch
    const validToken1 = makeToken('kid-1', key1.privateKey);
    const [c1, c2, c3] = await Promise.all([
      verifier.verifyIdToken(validToken1),
      verifier.verifyIdToken(validToken1),
      verifier.verifyIdToken(validToken1),
    ]);
    expect(c1.sub).toBe('sub-jwks');
    expect(c2.sub).toBe('sub-jwks');
    expect(c3.sub).toBe('sub-jwks');
    expect(jwksFetchCount).toBe(1);

    // Forged tokens with random unknown kids during cooldown must NOT trigger extra JWKS fetches
    for (let i = 0; i < 10; i++) {
      const forged = makeToken(`forged-kid-${i}`, key1.privateKey);
      await expect(verifier.verifyIdToken(forged)).rejects.toMatchObject({
        statusCode: 401,
        code: 'INVALID_GOOGLE_TOKEN',
      });
    }
    expect(jwksFetchCount).toBe(1);

    // After cooldown elapses, genuine key rotation refreshes JWKS (single-flight) and verifies kid-2
    rotated = true;
    await new Promise((resolve) => setTimeout(resolve, 75));
    const validToken2 = makeToken('kid-2', key2.privateKey);
    const [r1, r2] = await Promise.all([
      verifier.verifyIdToken(validToken2),
      verifier.verifyIdToken(validToken2),
    ]);
    expect(r1.sub).toBe('sub-jwks');
    expect(r2.sub).toBe('sub-jwks');
    expect(jwksFetchCount).toBe(2);

    // Slow-drip body timeout on JWKS fetch aborts after headers are received
    const slowBodyFetch = vi.fn<typeof fetch>(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"keys":'));
          // Never closes -> slow-drip
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const slowVerifier = new GoogleOidcVerifier({
      clientId,
      timeoutMs: 30,
      fetchImpl: slowBodyFetch,
    });
    await expect(slowVerifier.verifyIdToken(validToken1)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GOOGLE_AUTH_UPSTREAM_ERROR',
    });
  });

  it('deterministically preserves the newest session and revokes the oldest when exceeding 50 sessions in the same millisecond', () => {
    const userRepo = new UserRepository(db);
    const authSessionRepo = new AuthSessionRepository(db);
    const sameNowMs = 1_795_200_000_000;
    const { user } = userRepo.createPasswordUser({
      username: 'burst_user',
      usernameNormalized: 'burst_user',
      email: null,
      passwordHash: 'hash',
      displayName: 'Burst',
      nowMs: sameNowMs,
    });

    const createdIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = crypto.randomUUID();
      createdIds.push(id);
      authSessionRepo.create({
        id,
        userId: user.id,
        tokenHash: `hash-${i}`,
        provider: 'password',
        persistent: false,
        deviceLabel: `Device ${i}`,
        userAgent: null,
        createdAt: sameNowMs,
        expiresAt: sameNowMs + 3_600_000,
      });
      authSessionRepo.pruneAndCapForUser(user.id, 50, sameNowMs, id);
    }

    const active = authSessionRepo.listActiveByUser(user.id, sameNowMs);
    expect(active).toHaveLength(50);

    const activeIds = new Set(active.map((s) => s.id));
    // Oldest 5 sessions (0..4) must be revoked; newest 50 (5..54) including the latest must remain active
    for (let i = 0; i < 5; i++) {
      expect(activeIds.has(createdIds[i]!)).toBe(false);
    }
    for (let i = 5; i < 55; i++) {
      expect(activeIds.has(createdIds[i]!)).toBe(true);
    }
    expect(active[0]?.id).toBe(createdIds[54]);
  });
});
