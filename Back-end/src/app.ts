import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AuthProvider } from './auth/AuthProvider.js';
import { DeviceIdAuthProvider } from './auth/DeviceIdAuthProvider.js';
import type { AppDatabase } from './db/database.js';
import { createAuthenticateMiddleware } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { EventLogRepository } from './repositories/eventLogRepository.js';
import { SearchHistoryRepository } from './repositories/searchHistoryRepository.js';
import { SessionRepository } from './repositories/sessionRepository.js';
import { StatsRepository } from './repositories/statsRepository.js';
import { TaskRepository } from './repositories/taskRepository.js';
import { UserRepository } from './repositories/userRepository.js';
import { createV1Router } from './routes/v1/index.js';
import { PreferenceService } from './services/preferenceService.js';
import { PriorityRecalcQueue } from './services/priorityQueue.js';
import { PriorityService, type PriorityRulesConfig } from './services/priorityService.js';
import { SearchService, type SearchConfig } from './services/searchService.js';
import { SessionService } from './services/sessionService.js';
import { SyncService } from './services/syncService.js';
import { TaskService } from './services/taskService.js';

export interface CreateAppOptions {
  db: AppDatabase;
  audioDir?: string;
  corsOrigin?: string;
  authProvider?: AuthProvider;
  priorityQueue?: PriorityRecalcQueue;
  priorityConfig?: Partial<PriorityRulesConfig>;
  searchConfig?: SearchConfig;
  searchFetchImpl?: typeof fetch;
}

const DEFAULT_AUDIO_DIR = path.resolve(import.meta.dirname, '../assets/audio');

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  const audioDir = options.audioDir ?? DEFAULT_AUDIO_DIR;
  const userRepo = new UserRepository(options.db);
  const sessionRepo = new SessionRepository(options.db);
  const taskRepo = new TaskRepository(options.db);
  const eventLogRepo = new EventLogRepository(options.db);
  const statsRepo = new StatsRepository(options.db);
  const searchHistoryRepo = new SearchHistoryRepository(options.db);
  const priorityService = new PriorityService({
    db: options.db,
    taskRepo,
    config: options.priorityConfig,
  });
  const priorityQueue =
    options.priorityQueue ??
    new PriorityRecalcQueue((job) => {
      priorityService.recalculateTask(job.userId, job.taskId);
    });

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
  });
  const syncService = new SyncService({
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

  const authProvider = options.authProvider ?? new DeviceIdAuthProvider(userRepo);
  const authenticate = createAuthenticateMiddleware(authProvider);

  app.use(helmet());
  app.use(
    cors({
      origin: options.corsOrigin ?? '*',
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.use(
    '/api/v1',
    createV1Router({
      db: options.db,
      audioDir,
      userRepo,
      taskRepo,
      eventLogRepo,
      sessionService,
      preferenceService,
      taskService,
      syncService,
      searchService,
      priorityQueue,
      authenticate,
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
