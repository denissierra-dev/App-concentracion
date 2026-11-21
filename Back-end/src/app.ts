import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AuthProvider } from './auth/AuthProvider.js';
import { CompositeAuthProvider } from './auth/CompositeAuthProvider.js';
import { DeviceIdAuthProvider } from './auth/DeviceIdAuthProvider.js';
import {
  GoogleOidcVerifier,
  type GoogleOidcConfig,
  type GoogleTokenVerifier,
} from './auth/googleVerifier.js';
import { SessionTokenAuthProvider } from './auth/SessionTokenAuthProvider.js';
import type { AppDatabase } from './db/database.js';
import { createAuthenticateMiddleware } from './middleware/authenticate.js';
import { createCsrfCookieGuard } from './middleware/csrfGuard.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { AuthSessionRepository } from './repositories/authSessionRepository.js';
import { EventLogRepository } from './repositories/eventLogRepository.js';
import { SearchHistoryRepository } from './repositories/searchHistoryRepository.js';
import { SessionRepository } from './repositories/sessionRepository.js';
import { StatsRepository } from './repositories/statsRepository.js';
import { TaskRepository } from './repositories/taskRepository.js';
import { UserRepository } from './repositories/userRepository.js';
import { createV1Router } from './routes/v1/index.js';
import { safeJsonReviver } from './security/validators.js';
import { AuthService, type AuthServiceConfig } from './services/authService.js';
import { PreferenceService } from './services/preferenceService.js';
import { PriorityRecalcQueue } from './services/priorityQueue.js';
import { type PriorityRulesConfig } from './services/priorityService.js';
import { SearchService, type SearchConfig } from './services/searchService.js';
import { SessionService } from './services/sessionService.js';
import { StatsService } from './services/statsService.js';
import { SyncService } from './services/syncService.js';
import { TaskService } from './services/taskService.js';

export interface CreateAppOptions {
  db: AppDatabase;
  audioDir?: string;
  corsOrigin?: string;
  authProvider?: AuthProvider;
  authConfig?: AuthServiceConfig;
  googleAuthConfig?: GoogleOidcConfig;
  googleVerifier?: GoogleTokenVerifier;
  priorityQueue?: PriorityRecalcQueue;
  priorityConfig?: Partial<PriorityRulesConfig>;
  searchConfig?: SearchConfig;
  searchFetchImpl?: typeof fetch;
  enableRateLimit?: boolean;
  trustProxy?: boolean | number | string | string[];
}

const DEFAULT_AUDIO_DIR = path.resolve(import.meta.dirname, '../assets/audio');
const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

function parseCorsOrigins(rawCorsOrigin?: string): Set<string> {
  const configured = (rawCorsOrigin ?? DEFAULT_CORS_ORIGIN)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const allowlist = new Set<string>();
  for (const item of configured) {
    if (item === '*') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Wildcard CORS origin "*" is disallowed in production');
      }
      allowlist.add('*');
      continue;
    }

    const parsed = new URL(item);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid CORS origin protocol: ${parsed.protocol}`);
    }
    allowlist.add(parsed.origin);
  }

  return allowlist;
}

function buildCorsOriginValidator(allowlist: ReadonlySet<string>): (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
) => void {
  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowlist.has('*') || allowlist.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.set('trust proxy', options.trustProxy ?? false);

  const audioDir = options.audioDir ?? DEFAULT_AUDIO_DIR;
  const userRepo = new UserRepository(options.db);
  const authSessionRepo = new AuthSessionRepository(options.db);
  const sessionRepo = new SessionRepository(options.db);
  const taskRepo = new TaskRepository(options.db);
  const eventLogRepo = new EventLogRepository(options.db);
  const statsRepo = new StatsRepository(options.db);
  const searchHistoryRepo = new SearchHistoryRepository(options.db);
  const hasCustomPriorityQueue = options.priorityQueue !== undefined;
  const priorityQueue = options.priorityQueue ?? new PriorityRecalcQueue();

  const sessionService = new SessionService({
    db: options.db,
    sessionRepo,
    userRepo,
    eventLogRepo,
    statsRepo,
  });
  const preferenceService = new PreferenceService({
    db: options.db,
    userRepo,
    eventLogRepo,
  });
  const taskService = new TaskService({
    db: options.db,
    taskRepo,
    statsRepo,
    eventLogRepo,
    priorityConfig: options.priorityConfig,
    evaluatePriorityInline: !hasCustomPriorityQueue,
  });
  const syncService = new SyncService({
    db: options.db,
    sessionService,
    preferenceService,
    taskService,
    userRepo,
    taskRepo,
    priorityQueue,
  });
  const searchService = new SearchService({
    db: options.db,
    searchHistoryRepo,
    eventLogRepo,
    config: options.searchConfig,
    fetchImpl: options.searchFetchImpl,
  });
  const statsService = new StatsService({
    statsRepo,
  });
  const googleVerifier =
    options.googleVerifier ?? new GoogleOidcVerifier(options.googleAuthConfig ?? {});
  const authService = new AuthService({
    db: options.db,
    userRepo,
    authSessionRepo,
    eventLogRepo,
    googleVerifier,
    config: options.authConfig,
  });

  const authProvider =
    options.authProvider ??
    new CompositeAuthProvider(
      new SessionTokenAuthProvider(authSessionRepo, userRepo),
      new DeviceIdAuthProvider(userRepo)
    );
  const authenticate = createAuthenticateMiddleware(authProvider);
  const enableRateLimit = options.enableRateLimit ?? process.env.NODE_ENV !== 'test';
  const allowedCorsOrigins = parseCorsOrigins(options.corsOrigin);

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );
    next();
  });
  app.use(
    cors({
      origin: buildCorsOriginValidator(allowedCorsOrigins),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
      maxAge: 600,
    })
  );
  app.use('/api/v1', createCsrfCookieGuard(allowedCorsOrigins));
  app.use(express.json({ limit: '256kb', reviver: safeJsonReviver }));

  if (enableRateLimit) {
    app.use(
      '/api/v1',
      createRateLimiter({
        keyPrefix: 'api-global',
        windowMs: 60_000,
        maxRequests: 180,
        skip: (req) => req.method === 'GET' && /^\/audio\/tracks\/[^/]+\/stream$/.test(req.path),
      })
    );
  }

  app.use('/api/v1', (req, res, next) => {
    if (!req.path.endsWith('/stream')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  app.use(
    '/api/v1',
    createV1Router({
      db: options.db,
      audioDir,
      userRepo,
      taskRepo,
      eventLogRepo,
      authService,
      sessionService,
      preferenceService,
      taskService,
      syncService,
      searchService,
      statsService,
      priorityQueue,
      authenticate,
      enableRateLimit,
      allowedCorsOrigins,
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
