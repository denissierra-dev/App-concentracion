import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import { preferencePatchSchema, type PreferenceService } from '../../services/preferenceService.js';

const updatePreferencesRequestSchema = preferencePatchSchema.and(
  z.object({
    eventId: z.string().uuid().optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
);

export interface PreferencesRouterDeps {
  userRepo: UserRepository;
  preferenceService: PreferenceService;
  authenticate: RequestHandler;
}

export function createPreferencesRouter({
  userRepo,
  preferenceService,
  authenticate,
}: PreferencesRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/', (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      const preferences = userRepo.getPreferencesByUserId(req.auth.user.id);
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/', (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      const userId = req.auth.user.id;
      const body = updatePreferencesRequestSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const { preferences } = preferenceService.updatePreferences({
        userId,
        patch: body,
        eventId: body.eventId,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });

      res.json({ preferences, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
