import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database.js';
import { AppError } from '../../errors/AppError.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';

const registerDeviceSchema = z.object({
  deviceId: z.string().uuid().optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

export interface AuthRouterDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
  authenticate: RequestHandler;
}

export function createAuthRouter({
  db,
  userRepo,
  eventLogRepo,
  authenticate,
}: AuthRouterDeps): Router {
  const router = Router();

  /**
   * Registers a new anonymous deviceId (or generates one if omitted)
   * and returns the associated user + default preferences.
   * Idempotent: calling again with the same deviceId recovers the account.
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
   * Validates current credentials and returns the authenticated user + preferences.
   */
  router.get('/me', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      const preferences = userRepo.getPreferencesByUserId(req.auth.user.id);
      res.json({
        provider: req.auth.provider,
        user: {
          id: req.auth.user.id,
          authProvider: req.auth.user.authProvider,
          deviceId: req.auth.user.externalId,
          createdAt: req.auth.user.createdAt,
        },
        preferences,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
