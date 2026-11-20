import { z } from 'zod';
import type { AppDatabase } from '../db/database.js';
import type { Preference } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { EventLogRepository } from '../repositories/eventLogRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import { SESSION_LIMITS } from './sessionPlanner.js';

export const preferencePatchSchema = z
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

export type PreferencePatchPayload = z.infer<typeof preferencePatchSchema>;

export interface PreferenceServiceDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
}

export interface UpdatePreferencesParams {
  userId: string;
  patch: PreferencePatchPayload;
  eventId?: string;
  clientTimestamp?: number;
  nowMs?: number;
}

export class PreferenceService {
  constructor(private readonly deps: PreferenceServiceDeps) {}

  updatePreferences(params: UpdatePreferencesParams): {
    idempotent: boolean;
    preferences: Preference | null;
  } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      if (params.eventId) {
        const existing = this.deps.eventLogRepo.findByEventIdForUser(
          params.eventId,
          params.userId
        );
        if (existing) {
          if (
            existing.entityType !== 'preference' ||
            existing.eventType !== 'PREFERENCES_UPDATED'
          ) {
            throw new AppError(
              409,
              'EVENT_ID_CONFLICT',
              'Event ID was already used for a different action'
            );
          }
          return {
            idempotent: true,
            preferences: this.deps.userRepo.getPreferencesByUserId(params.userId),
          };
        }
      }

      const updated = this.deps.userRepo.updatePreferences(
        params.userId,
        {
          focusDurationMin: params.patch.focusDurationMin,
          shortBreakMin: params.patch.shortBreakMin,
          longBreakMin: params.patch.longBreakMin,
          cyclesBeforeLongBreak: params.patch.cyclesBeforeLongBreak,
          volumeFocus: params.patch.volumeFocus,
          volumeBreak: params.patch.volumeBreak,
          notificationsEnabled: params.patch.notificationsEnabled,
          theme: params.patch.theme,
        },
        nowMs
      );

      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'preference',
        entityId: params.userId,
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
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, preferences: updated };
    })();
  }
}
