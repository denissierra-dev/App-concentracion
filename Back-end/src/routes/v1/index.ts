import { Router, type RequestHandler } from 'express';
import type { AppDatabase } from '../../db/database.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { TaskRepository } from '../../repositories/taskRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { PreferenceService } from '../../services/preferenceService.js';
import type { PriorityRecalcQueue } from '../../services/priorityQueue.js';
import type { SessionService } from '../../services/sessionService.js';
import type { SyncService } from '../../services/syncService.js';
import type { TaskService } from '../../services/taskService.js';
import { createAuthRouter } from './auth.routes.js';
import { createAudioRouter } from './audio.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createPreferencesRouter } from './preferences.routes.js';
import { createSessionsRouter } from './sessions.routes.js';
import { createSyncRouter } from './sync.routes.js';
import { createTasksRouter } from './tasks.routes.js';
import { createTimeRouter } from './time.routes.js';

export interface V1RouterDeps {
  db: AppDatabase;
  audioDir: string;
  userRepo: UserRepository;
  taskRepo: TaskRepository;
  eventLogRepo: EventLogRepository;
  sessionService: SessionService;
  preferenceService: PreferenceService;
  taskService: TaskService;
  syncService: SyncService;
  priorityQueue: PriorityRecalcQueue;
  authenticate: RequestHandler;
}

export function createV1Router(deps: V1RouterDeps): Router {
  const router = Router();

  router.use('/health', createHealthRouter());
  router.use('/time', createTimeRouter());
  router.use(
    '/audio',
    createAudioRouter({
      audioDir: deps.audioDir,
      userRepo: deps.userRepo,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/auth',
    createAuthRouter({
      db: deps.db,
      userRepo: deps.userRepo,
      eventLogRepo: deps.eventLogRepo,
      authenticate: deps.authenticate,
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

  return router;
}
