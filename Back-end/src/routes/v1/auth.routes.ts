import crypto from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../../auth/SessionTokenAuthProvider.js';
import type { AppDatabase } from '../../db/database.js';
import { AppError } from '../../errors/AppError.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import {
  CONTROL_AND_BIDI_TEST_REGEX,
  nonNilUuidSchema,
  safeSingleLineTextSchema,
  stripControlAndBidiChars,
} from '../../security/validators.js';
import { toPublicUser, type AuthService } from '../../services/authService.js';

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;

const registerDeviceSchema = z.object({
  deviceId: nonNilUuidSchema.optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((val) => !CONTROL_AND_BIDI_TEST_REGEX.test(val), {
    message: 'Password contains disallowed control characters',
  });

const usernameSchema = z
  .string()
  .trim()
  .regex(
    USERNAME_REGEX,
    'Username must be 3-32 characters using only letters, numbers, "_", ".", or "-"'
  );

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email('Invalid email address')
  .transform((val) => val.toLowerCase());

const deviceLabelSchema = safeSingleLineTextSchema(1, 80, 'Device label').optional();

const registerPasswordSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema.nullable().optional(),
  displayName: safeSingleLineTextSchema(1, 80, 'Display name').nullable().optional(),
  rememberMe: z.boolean().optional().default(false),
  deviceLabel: deviceLabelSchema,
  clientTimestamp: z.number().int().positive().optional(),
});

const loginPasswordSchema = z
  .object({
    identifier: safeSingleLineTextSchema(1, 254, 'Identifier').optional(),
    username: safeSingleLineTextSchema(1, 254, 'Username').optional(),
    email: safeSingleLineTextSchema(1, 254, 'Email').optional(),
    password: z
      .string()
      .min(1, 'Password is required')
      .max(128)
      .refine((val) => !CONTROL_AND_BIDI_TEST_REGEX.test(val), {
        message: 'Password contains disallowed control characters',
      }),
    rememberMe: z.boolean().optional().default(false),
    deviceLabel: deviceLabelSchema,
    clientTimestamp: z.number().int().positive().optional(),
  })
  .refine((data) => Boolean(data.identifier || data.username || data.email), {
    message: 'Username, email, or identifier is required',
  });

const googleSignInSchema = z
  .object({
    idToken: z.string().trim().min(10).max(8192).optional(),
    credential: z.string().trim().min(10).max(8192).optional(),
    code: z.string().trim().min(4).max(2048).optional(),
    redirectUri: z.string().trim().url().max(512).optional(),
    codeVerifier: z.string().trim().min(16).max(256).optional(),
    rememberMe: z.boolean().optional().default(true),
    deviceLabel: deviceLabelSchema,
    clientTimestamp: z.number().int().positive().optional(),
  })
  .refine(
    (data) =>
      Boolean(data.idToken || data.credential || (data.code && data.redirectUri)),
    {
      message: 'Either idToken (or credential) or code with redirectUri must be provided',
    }
  );

const linkGoogleSchema = z
  .object({
    idToken: z.string().trim().min(10).max(8192).optional(),
    credential: z.string().trim().min(10).max(8192).optional(),
    code: z.string().trim().min(4).max(2048).optional(),
    redirectUri: z.string().trim().url().max(512).optional(),
    codeVerifier: z.string().trim().min(16).max(256).optional(),
  })
  .refine(
    (data) =>
      Boolean(data.idToken || data.credential || (data.code && data.redirectUri)),
    {
      message: 'Either idToken (or credential) or code with redirectUri must be provided',
    }
  );

const sessionIdParamSchema = z.object({
  id: nonNilUuidSchema,
});

function setSessionCookie(res: Response, token: string, persistent: boolean, expiresAt: number): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api/v1',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (persistent) {
    const maxAgeSec = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    attributes.push(`Max-Age=${maxAgeSec}`);
  }

  if (process.env.NODE_ENV === 'production') {
    attributes.push('Secure');
  }

  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/api/v1',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];

  if (process.env.NODE_ENV === 'production') {
    attributes.push('Secure');
  }

  res.setHeader('Set-Cookie', attributes.join('; '));
}

export interface AuthRouterDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
  authService: AuthService;
  authenticate: RequestHandler;
  allowedOrigins?: ReadonlySet<string>;
}

function assertAllowedRedirectUri(
  redirectUri: string | undefined,
  allowedOrigins?: ReadonlySet<string>
): void {
  if (!redirectUri) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid redirectUri');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid redirectUri protocol');
  }

  if (parsed.username || parsed.password) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Credentials are not allowed in redirectUri');
  }

  if (allowedOrigins && !allowedOrigins.has('*') && !allowedOrigins.has(parsed.origin)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Disallowed redirectUri origin');
  }
}

export function createAuthRouter({
  db,
  userRepo,
  eventLogRepo,
  authService,
  authenticate,
  allowedOrigins,
}: AuthRouterDeps): Router {
  const router = Router();

  /**
   * Lists enabled authentication providers and public OAuth client configuration.
   */
  router.get('/providers', (_req, res) => {
    res.json({
      providers: authService.getProvidersInfo(),
      serverTimeMs: Date.now(),
    });
  });

  /**
   * Registers a new username + password user and issues a short-lived or persistent session.
   */
  router.post('/register', async (req, res, next) => {
    try {
      const body = registerPasswordSchema.parse(req.body ?? {});
      const userAgent = stripControlAndBidiChars(req.header('user-agent') ?? '', 200) || null;

      const result = await authService.registerWithPassword({
        username: body.username,
        password: body.password,
        email: body.email ?? null,
        displayName: body.displayName ?? null,
        rememberMe: body.rememberMe,
        deviceLabel: body.deviceLabel ?? null,
        userAgent,
        clientTimestamp: body.clientTimestamp,
      });

      setSessionCookie(res, result.token, result.rememberMe, result.expiresAt);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Authenticates an existing user via username or email + password.
   */
  router.post('/login', async (req, res, next) => {
    try {
      const body = loginPasswordSchema.parse(req.body ?? {});
      const identifier = body.identifier ?? body.username ?? body.email ?? '';
      const userAgent = stripControlAndBidiChars(req.header('user-agent') ?? '', 200) || null;

      const result = await authService.loginWithPassword({
        identifier,
        password: body.password,
        rememberMe: body.rememberMe,
        deviceLabel: body.deviceLabel ?? null,
        userAgent,
        clientTimestamp: body.clientTimestamp,
      });

      setSessionCookie(res, result.token, result.rememberMe, result.expiresAt);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Signs in (or registers) using a Google ID token or OAuth2 authorization code,
   * optionally persisting the session (`rememberMe: true` by default).
   */
  router.post('/google', async (req, res, next) => {
    try {
      const body = googleSignInSchema.parse(req.body ?? {});
      assertAllowedRedirectUri(body.redirectUri, allowedOrigins);
      const userAgent = stripControlAndBidiChars(req.header('user-agent') ?? '', 200) || null;

      const result = await authService.signInWithGoogle({
        idToken: body.idToken ?? body.credential,
        code: body.code,
        redirectUri: body.redirectUri,
        codeVerifier: body.codeVerifier,
        rememberMe: body.rememberMe,
        deviceLabel: body.deviceLabel ?? null,
        userAgent,
        clientTimestamp: body.clientTimestamp,
      });

      setSessionCookie(res, result.token, result.rememberMe, result.expiresAt);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Links a Google account to an already-authenticated user.
   */
  router.post('/link/google', authenticate, async (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }
      const body = linkGoogleSchema.parse(req.body ?? {});
      assertAllowedRedirectUri(body.redirectUri, allowedOrigins);
      const user = await authService.linkGoogleAccount({
        userId: req.auth.user.id,
        idToken: body.idToken ?? body.credential,
        code: body.code,
        redirectUri: body.redirectUri,
        codeVerifier: body.codeVerifier,
      });

      res.json({ linked: true, user });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Revokes the current saved session token and clears the session cookie.
   */
  router.post('/logout', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }
      const result = authService.logoutCurrent(req.auth.user.id, req.auth.authSession?.id);
      clearSessionCookie(res);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Revokes all saved sessions for the authenticated user.
   */
  router.post('/logout-all', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }
      const result = authService.logoutAll(req.auth.user.id);
      clearSessionCookie(res);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Lists active saved sessions for the authenticated user.
   */
  router.get('/sessions', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }
      const sessions = authService.listActiveSessions(req.auth.user.id, req.auth.authSession?.id);
      res.json({ sessions, serverTimeMs: Date.now() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Revokes a specific saved session owned by the authenticated user.
   */
  router.delete('/sessions/:id', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }
      const { id } = sessionIdParamSchema.parse(req.params);
      const result = authService.revokeSession(req.auth.user.id, id);
      if (req.auth.authSession?.id === id) {
        clearSessionCookie(res);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Legacy anonymous device registration (kept for backward compatibility).
   */
  router.post('/device', (req, res, next) => {
    try {
      const body = registerDeviceSchema.parse(req.body ?? {});
      const deviceId = body.deviceId ?? crypto.randomUUID();
      const nowMs = Date.now();

      const { user, preferences, created } = db.transaction(() => {
        const result = userRepo.findOrCreateDeviceUser('device', deviceId, nowMs);
        if (result.created) {
          eventLogRepo.append({
            userId: result.user.id,
            entityType: 'user',
            entityId: result.user.id,
            eventType: 'USER_REGISTERED',
            payload: { authProvider: 'device' },
            clientTimestamp: body.clientTimestamp ?? null,
            serverTimestamp: nowMs,
          });
        }
        return result;
      })();

      res.status(created ? 201 : 200).json({
        deviceId,
        created,
        user: {
          id: user.id,
          authProvider: user.authProvider,
          createdAt: user.createdAt,
        },
        preferences,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Validates current credentials (Bearer token, session cookie, or legacy deviceId)
   * and returns the authenticated user + preferences + active auth session info.
   */
  router.get('/me', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      const preferences = userRepo.getPreferencesByUserId(req.auth.user.id);
      res.json({
        provider: req.auth.provider,
        user: toPublicUser(req.auth.user),
        preferences,
        session: req.auth.authSession
          ? {
              id: req.auth.authSession.id,
              persistent: req.auth.authSession.persistent,
              expiresAt: req.auth.authSession.expiresAt,
              deviceLabel: req.auth.authSession.deviceLabel,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
