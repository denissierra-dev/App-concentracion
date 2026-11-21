import { Router, type RequestHandler } from 'express';
import type { AppDatabase } from '../../db/database.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { TaskRepository } from '../../repositories/taskRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { AuthService } from '../../services/authService.js';
import type { PreferenceService } from '../../services/preferenceService.js';
import type { PriorityRecalcQueue } from '../../services/priorityQueue.js';
import type { SessionService } from '../../services/sessionService.js';
import type { StatsService } from '../../services/statsService.js';
import type { SyncService } from '../../services/syncService.js';
import type { SearchService } from '../../services/searchService.js';
import type { TaskService } from '../../services/taskService.js';
import { createAuthRouter } from './auth.routes.js';
import { createAudioRouter } from './audio.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createPreferencesRouter } from './preferences.routes.js';
import { createSearchRouter } from './search.routes.js';
import { createSessionsRouter } from './sessions.routes.js';
import { createStatsRouter } from './stats.routes.js';
import { createSyncRouter } from './sync.routes.js';
import { createTasksRouter } from './tasks.routes.js';
import { createTimeRouter } from './time.routes.js';

export interface V1RouterDeps {
  db: AppDatabase;
  audioDir: string;
  userRepo: UserRepository;
  taskRepo: TaskRepository;
  eventLogRepo: EventLogRepository;
  authService: AuthService;
  sessionService: SessionService;
  preferenceService: PreferenceService;
  taskService: TaskService;
  syncService: SyncService;
  searchService: SearchService;
  statsService: StatsService;
  priorityQueue: PriorityRecalcQueue;
  authenticate: RequestHandler;
  enableRateLimit?: boolean;
  allowedCorsOrigins?: ReadonlySet<string>;
}

export function createV1Router(deps: V1RouterDeps): Router {
  const router = Router();
  const useRateLimit = deps.enableRateLimit ?? false;

  const authDeviceLimiter = useRateLimit
    ? createRateLimiter({
        keyPrefix: 'auth-device',
        windowMs: 60_000,
        maxRequests: 20,
        message: 'Too many device registration requests; please try again later',
      })
    : null;

  const authCredentialsLimiter = useRateLimit
    ? createRateLimiter({
        keyPrefix: 'auth-credentials',
        windowMs: 60_000,
        maxRequests: 15,
        message: 'Too many authentication attempts; please try again later',
      })
    : null;

  const searchProxyLimiter = useRateLimit
    ? createRateLimiter({
        keyPrefix: 'search-proxy',
        windowMs: 60_000,
        maxRequests: 30,
        keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? req.socket.remoteAddress ?? 'unknown',
        message: 'Search rate limit exceeded; please slow down',
      })
    : null;

  const audioStreamLimiter = useRateLimit
    ? createRateLimiter({
        keyPrefix: 'audio-stream',
        windowMs: 60_000,
        maxRequests: 1200,
        message: 'Audio stream rate limit exceeded; please slow down',
      })
    : null;

  router.use('/health', createHealthRouter());
  router.use('/time', createTimeRouter());
  if (audioStreamLimiter) {
    router.get('/audio/tracks/:id/stream', audioStreamLimiter);
  }
  router.use(
    '/audio',
    createAudioRouter({
      audioDir: deps.audioDir,
      userRepo: deps.userRepo,
      authenticate: deps.authenticate,
    })
  );
  if (authDeviceLimiter) {
    router.post('/auth/device', authDeviceLimiter);
  }
  if (authCredentialsLimiter) {
    router.post('/auth/login', authCredentialsLimiter);
    router.post('/auth/register', authCredentialsLimiter);
    router.post('/auth/google', authCredentialsLimiter);
    router.post('/auth/link/google', authCredentialsLimiter);
  }
  router.use(
    '/auth',
    createAuthRouter({
      db: deps.db,
      userRepo: deps.userRepo,
      eventLogRepo: deps.eventLogRepo,
      authService: deps.authService,
      authenticate: deps.authenticate,
      allowedOrigins: deps.allowedCorsOrigins,
    })
  );
  router.use(
    '/preferences',
    createPreferencesRouter({
      userRepo: deps.userRepo,
      preferenceService: deps.preferenceService,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/sessions',
    createSessionsRouter({
      sessionService: deps.sessionService,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/tasks',
    createTasksRouter({
      taskRepo: deps.taskRepo,
      taskService: deps.taskService,
      priorityQueue: deps.priorityQueue,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/sync',
    createSyncRouter({
      syncService: deps.syncService,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/search',
    createSearchRouter({
      searchService: deps.searchService,
      authenticate: deps.authenticate,
      searchLimiter: searchProxyLimiter ?? undefined,
    })
  );
  router.use(
    '/stats',
    createStatsRouter({
      statsService: deps.statsService,
      authenticate: deps.authenticate,
    })
  );

  return router;
}
