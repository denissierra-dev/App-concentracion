import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database.js';
import { AppError } from '../../errors/AppError.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import { SESSION_LIMITS } from '../../services/sessionPlanner.js';

const updatePreferencesSchema = z
  .object({
    focusDurationMin: z
      .number()
      .int()
      .min(SESSION_LIMITS.MIN_FOCUS_MIN)
      .max(SESSION_LIMITS.MAX_FOCUS_MIN)
      .optional(),
    shortBreakMin: z.number().int().min(1).max(60).optional(),
    longBreakMin: z.number().int().min(5).max(60).optional(),
    cyclesBeforeLongBreak: z
      .number()
      .int()
      .min(SESSION_LIMITS.MIN_CYCLES)
      .max(SESSION_LIMITS.MAX_CYCLES)
      .optional(),
    volumeFocus: z.number().min(0).max(1).optional(),
    volumeBreak: z.number().min(0).max(1).optional(),
    notificationsEnabled: z.boolean().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    eventId: z.string().uuid().optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .refine(
    (data) =>
      data.focusDurationMin !== undefined ||
      data.shortBreakMin !== undefined ||
      data.longBreakMin !== undefined ||
      data.cyclesBeforeLongBreak !== undefined ||
      data.volumeFocus !== undefined ||
      data.volumeBreak !== undefined ||
      data.notificationsEnabled !== undefined ||
      data.theme !== undefined,
    { message: 'At least one preference field must be provided' }
  );

export interface PreferencesRouterDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
  authenticate: RequestHandler;
}

export function createPreferencesRouter({
  db,
  userRepo,
  eventLogRepo,
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
      const body = updatePreferencesSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const preferences = db.transaction(() => {
        if (body.eventId) {
          const existing = eventLogRepo.findByEventIdForUser(body.eventId, userId);
          if (existing) {
            if (existing.entityType !== 'preference') {
              throw new AppError(
                409,
                'EVENT_ID_CONFLICT',
                'Event ID was already used for a different action'
              );
            }
            return userRepo.getPreferencesByUserId(userId);
          }
        }

        const updated = userRepo.updatePreferences(
          userId,
          {
            focusDurationMin: body.focusDurationMin,
            shortBreakMin: body.shortBreakMin,
            longBreakMin: body.longBreakMin,
            cyclesBeforeLongBreak: body.cyclesBeforeLongBreak,
            volumeFocus: body.volumeFocus,
            volumeBreak: body.volumeBreak,
            notificationsEnabled: body.notificationsEnabled,
            theme: body.theme,
          },
          nowMs
        );

        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'preference',
          entityId: userId,
          eventType: 'PREFERENCES_UPDATED',
          payload: {
            focusDurationMin: updated.focusDurationMin,
            shortBreakMin: updated.shortBreakMin,
            longBreakMin: updated.longBreakMin,
            cyclesBeforeLongBreak: updated.cyclesBeforeLongBreak,
            volumeFocus: updated.volumeFocus,
            volumeBreak: updated.volumeBreak,
            notificationsEnabled: updated.notificationsEnabled,
            theme: updated.theme,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return updated;
      })();

      res.json({ preferences, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
