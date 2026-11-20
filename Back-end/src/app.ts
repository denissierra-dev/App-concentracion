import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AuthProvider } from './auth/AuthProvider.js';
import { DeviceIdAuthProvider } from './auth/DeviceIdAuthProvider.js';
import type { AppDatabase } from './db/database.js';
import { createAuthenticateMiddleware } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { EventLogRepository } from './repositories/eventLogRepository.js';
import { SessionRepository } from './repositories/sessionRepository.js';
import { StatsRepository } from './repositories/statsRepository.js';
import { UserRepository } from './repositories/userRepository.js';
import { createV1Router } from './routes/v1/index.js';

export interface CreateAppOptions {
  db: AppDatabase;
  corsOrigin?: string;
  authProvider?: AuthProvider;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  const userRepo = new UserRepository(options.db);
  const sessionRepo = new SessionRepository(options.db);
  const eventLogRepo = new EventLogRepository(options.db);
  const statsRepo = new StatsRepository(options.db);
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
      userRepo,
      sessionRepo,
      eventLogRepo,
      statsRepo,
      authenticate,
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
