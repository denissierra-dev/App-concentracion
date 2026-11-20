import { Router, type RequestHandler } from 'express';
import type { AppDatabase } from '../../db/database.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { SessionRepository } from '../../repositories/sessionRepository.js';
import type { StatsRepository } from '../../repositories/statsRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import { createAuthRouter } from './auth.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createPreferencesRouter } from './preferences.routes.js';
import { createSessionsRouter } from './sessions.routes.js';
import { createTimeRouter } from './time.routes.js';

export interface V1RouterDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  sessionRepo: SessionRepository;
  eventLogRepo: EventLogRepository;
  statsRepo: StatsRepository;
  authenticate: RequestHandler;
}

export function createV1Router(deps: V1RouterDeps): Router {
  const router = Router();

  router.use('/health', createHealthRouter());
  router.use('/time', createTimeRouter());
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
      db: deps.db,
      userRepo: deps.userRepo,
      eventLogRepo: deps.eventLogRepo,
      authenticate: deps.authenticate,
    })
  );
  router.use(
    '/sessions',
    createSessionsRouter({
      db: deps.db,
      sessionRepo: deps.sessionRepo,
      userRepo: deps.userRepo,
      eventLogRepo: deps.eventLogRepo,
      statsRepo: deps.statsRepo,
      authenticate: deps.authenticate,
    })
  );

  return router;
}
