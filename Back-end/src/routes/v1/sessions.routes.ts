import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database.js';
import type { Session } from '../../domain/types.js';
import { AppError } from '../../errors/AppError.js';
import type { EventLogRepository } from '../../repositories/eventLogRepository.js';
import type { SessionRepository } from '../../repositories/sessionRepository.js';
import type { StatsRepository } from '../../repositories/statsRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import {
  buildSessionPlan,
  computeCurrentIndexAt,
  reanchorPlanFromIndex,
  SESSION_LIMITS,
  shiftPlanFromIndex,
} from '../../services/sessionPlanner.js';

const createSessionSchema = z.object({
  sessionId: z.string().uuid().optional(),
  focusDurationMin: z
    .number()
    .int()
    .min(SESSION_LIMITS.MIN_FOCUS_MIN)
    .max(SESSION_LIMITS.MAX_FOCUS_MIN)
    .optional(),
  totalCycles: z
    .number()
    .int()
    .min(SESSION_LIMITS.MIN_CYCLES)
    .max(SESSION_LIMITS.MAX_CYCLES)
    .default(SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK),
  eventId: z.string().uuid().optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

const controlEventSchema = z
  .object({
    eventId: z.string().uuid().optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .optional()
  .default({});

const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export interface SessionsRouterDeps {
  db: AppDatabase;
  sessionRepo: SessionRepository;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
  statsRepo: StatsRepository;
  authenticate: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

function loadOwnedSession(
  sessionRepo: SessionRepository,
  sessionId: string,
  userId: string
): Session {
  const session = sessionRepo.findByIdForUser(sessionId, userId);
  if (!session) {
    throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }
  return session;
}

/**
 * Checks whether a control eventId was already applied for this user/session/action.
 * Throws 409 EVENT_ID_CONFLICT if reused across a different session or eventType.
 */
function isIdempotentControlReplay(
  eventLogRepo: EventLogRepository,
  params: { eventId?: string; userId: string; sessionId: string; eventType: string }
): boolean {
  if (!params.eventId) {
    return false;
  }

  const existing = eventLogRepo.findByEventIdForUser(params.eventId, params.userId);
  if (!existing) {
    return false;
  }

  if (
    existing.entityType !== 'session' ||
    existing.entityId !== params.sessionId ||
    existing.eventType !== params.eventType
  ) {
    throw new AppError(
      409,
      'EVENT_ID_CONFLICT',
      'Event ID was already used for a different action'
    );
  }

  return true;
}

/**
 * Lazily closes an active session if the server clock has already passed
 * the final phase's `endsAt`. Must run inside a transaction when called alongside mutations.
 */
function reconcileExpiredActiveSession(
  db: AppDatabase,
  session: Session,
  nowMs: number,
  sessionRepo: SessionRepository,
  eventLogRepo: EventLogRepository,
  statsRepo: StatsRepository
): Session {
  if (session.status !== 'active' || session.plan.length === 0) {
    return session;
  }

  const effectiveIndex = computeCurrentIndexAt(session.plan, session.currentIndex, nowMs);
  if (effectiveIndex < session.plan.length) {
    return session;
  }

  const lastPhase = session.plan[session.plan.length - 1]!;
  const completed: Session = {
    ...session,
    status: 'completed',
    currentIndex: session.plan.length,
    pausedAt: null,
    endedAt: lastPhase.endsAt,
    version: session.version + 1,
    updatedAt: nowMs,
  };

  return db.transaction(() => {
    sessionRepo.update(completed, session.version);
    statsRepo.recordCompletedSession({
      userId: completed.userId,
      sessionId: completed.id,
      plan: completed.plan,
      reachedIndex: completed.plan.length - 1,
      endedAt: lastPhase.endsAt,
      skippedFinal: false,
      nowMs,
    });
    eventLogRepo.append({
      userId: completed.userId,
      entityType: 'session',
      entityId: completed.id,
      eventType: 'SESSION_ENDED',
      payload: {
        reason: 'plan_completed',
        currentIndex: completed.currentIndex,
        accumulatedPauseMs: completed.accumulatedPauseMs,
        version: completed.version,
      },
      clientTimestamp: null,
      serverTimestamp: nowMs,
    });
    return completed;
  })();
}

function resolveSessionMetricsAt(
  session: Session,
  nowMs: number
): { effectiveIndex: number; accumulatedPauseMs: number } {
  const effectiveIndex =
    session.status === 'active'
      ? computeCurrentIndexAt(session.plan, session.currentIndex, nowMs)
      : session.currentIndex;

  const pendingPauseMs =
    session.status === 'paused' && session.pausedAt !== null
      ? Math.max(0, nowMs - session.pausedAt)
      : 0;

  return {
    effectiveIndex,
    accumulatedPauseMs: session.accumulatedPauseMs + pendingPauseMs,
  };
}

export function createSessionsRouter({
  db,
  sessionRepo,
  userRepo,
  eventLogRepo,
  statsRepo,
  authenticate,
}: SessionsRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  /**
   * Creates a new focus session with a complete precomputed plan + version.
   * Idempotent by `sessionId` when provided for the same user.
   */
  router.post('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = createSessionSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const result = db.transaction(() => {
        if (body.sessionId) {
          const existing = sessionRepo.findByIdForUser(body.sessionId, userId);
          if (existing) {
            return { created: false, session: existing };
          }
          if (sessionRepo.existsById(body.sessionId)) {
            throw new AppError(409, 'SESSION_ID_CONFLICT', 'Session ID is already in use');
          }
        }

        const inProgress = sessionRepo.findCurrentByUser(userId);
        if (inProgress) {
          const reconciled = reconcileExpiredActiveSession(
            db,
            inProgress,
            nowMs,
            sessionRepo,
            eventLogRepo,
            statsRepo
          );
          if (reconciled.status === 'active' || reconciled.status === 'paused') {
            throw new AppError(
              409,
              'ACTIVE_SESSION_EXISTS',
              'An active or paused session already exists for this user',
              { activeSessionId: reconciled.id, status: reconciled.status }
            );
          }
        }

        const prefs = userRepo.getPreferencesByUserId(userId);
        const focusDurationMin = body.focusDurationMin ?? prefs?.focusDurationMin ?? 25;
        const cyclesBeforeLongBreak =
          prefs?.cyclesBeforeLongBreak ?? SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK;

        const sessionId = body.sessionId ?? crypto.randomUUID();
        const plan = buildSessionPlan({
          focusDurationMin,
          totalCycles: body.totalCycles,
          startedAt: nowMs,
          cyclesBeforeLongBreak,
        });

        const session: Session = {
          id: sessionId,
          userId,
          status: 'active',
          plan,
          currentIndex: 0,
          startedAt: nowMs,
          accumulatedPauseMs: 0,
          pausedAt: null,
          endedAt: null,
          version: 1,
          createdAt: nowMs,
          updatedAt: nowMs,
        };

        sessionRepo.create(session);
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: session.id,
          eventType: 'SESSION_STARTED',
          payload: {
            focusDurationMin,
            totalCycles: body.totalCycles,
            version: session.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { created: true, session };
      })();

      res.status(result.created ? 201 : 200).json({
        created: result.created,
        session: result.session,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Recovers the current in-progress ('active' or 'paused') session for the user.
   */
  router.get('/active', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const nowMs = Date.now();
      const current = sessionRepo.findCurrentByUser(userId);

      if (!current) {
        res.json({ session: null, currentPhase: null, serverTimeMs: nowMs });
        return;
      }

      const session = reconcileExpiredActiveSession(
        db,
        current,
        nowMs,
        sessionRepo,
        eventLogRepo,
        statsRepo
      );
      if (session.status !== 'active' && session.status !== 'paused') {
        res.json({ session: null, currentPhase: null, serverTimeMs: nowMs });
        return;
      }

      const effectiveIndex =
        session.status === 'active'
          ? computeCurrentIndexAt(session.plan, session.currentIndex, nowMs)
          : session.currentIndex;
      const currentPhase = session.plan[effectiveIndex] ?? null;

      res.json({
        session: {
          ...session,
          currentIndex: effectiveIndex,
        },
        currentPhase,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * On-demand session state retrieval (e.g., on reconnect).
   */
  router.get('/:id/state', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const nowMs = Date.now();
      const session = reconcileExpiredActiveSession(
        db,
        loadOwnedSession(sessionRepo, id, userId),
        nowMs,
        sessionRepo,
        eventLogRepo,
        statsRepo
      );

      const effectiveIndex =
        session.status === 'active'
          ? computeCurrentIndexAt(session.plan, session.currentIndex, nowMs)
          : session.currentIndex;

      const currentPhase = session.plan[effectiveIndex] ?? null;

      res.json({
        session: {
          ...session,
          currentIndex: effectiveIndex,
        },
        currentPhase,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Pauses an active session. Breaks the original plan timeline.
   */
  router.post('/:id/pause', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();

      const result = db.transaction(() => {
        const loaded = loadOwnedSession(sessionRepo, id, userId);
        if (
          isIdempotentControlReplay(eventLogRepo, {
            eventId: body.eventId,
            userId,
            sessionId: loaded.id,
            eventType: 'SESSION_PAUSED',
          })
        ) {
          return { idempotent: true, session: loaded };
        }

        const session = reconcileExpiredActiveSession(
          db,
          loaded,
          nowMs,
          sessionRepo,
          eventLogRepo,
          statsRepo
        );

        if (session.status !== 'active') {
          throw new AppError(
            409,
            'INVALID_SESSION_STATE',
            `Cannot pause session in '${session.status}' state`
          );
        }

        const effectiveIndex = computeCurrentIndexAt(session.plan, session.currentIndex, nowMs);
        const updated: Session = {
          ...session,
          status: 'paused',
          currentIndex: effectiveIndex,
          pausedAt: nowMs,
          version: session.version + 1,
          updatedAt: nowMs,
        };

        sessionRepo.update(updated, session.version);
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: updated.id,
          eventType: 'SESSION_PAUSED',
          payload: {
            currentIndex: updated.currentIndex,
            version: updated.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { idempotent: false, session: updated };
      })();

      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Resumes a paused session, shifting `endsAt` of the current phase and
   * `startsAt`/`endsAt` of future phases by pause duration.
   */
  router.post('/:id/resume', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();

      const result = db.transaction(() => {
        const session = loadOwnedSession(sessionRepo, id, userId);
        if (
          isIdempotentControlReplay(eventLogRepo, {
            eventId: body.eventId,
            userId,
            sessionId: session.id,
            eventType: 'SESSION_RESUMED',
          })
        ) {
          return { idempotent: true, session };
        }

        if (session.status !== 'paused' || session.pausedAt === null) {
          throw new AppError(
            409,
            'INVALID_SESSION_STATE',
            `Cannot resume session in '${session.status}' state`
          );
        }

        const pauseDeltaMs = Math.max(0, nowMs - session.pausedAt);
        const shiftedPlan = shiftPlanFromIndex(session.plan, session.currentIndex, pauseDeltaMs);

        const updated: Session = {
          ...session,
          status: 'active',
          plan: shiftedPlan,
          accumulatedPauseMs: session.accumulatedPauseMs + pauseDeltaMs,
          pausedAt: null,
          version: session.version + 1,
          updatedAt: nowMs,
        };

        sessionRepo.update(updated, session.version);
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: updated.id,
          eventType: 'SESSION_RESUMED',
          payload: {
            pauseDeltaMs,
            accumulatedPauseMs: updated.accumulatedPauseMs,
            version: updated.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { idempotent: false, session: updated };
      })();

      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Skips the current phase, re-anchoring subsequent phases to `nowMs`
   * (or completing the session if skipping the final phase).
   */
  router.post('/:id/skip', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();

      const result = db.transaction(() => {
        const loaded = loadOwnedSession(sessionRepo, id, userId);
        if (
          isIdempotentControlReplay(eventLogRepo, {
            eventId: body.eventId,
            userId,
            sessionId: loaded.id,
            eventType: 'PHASE_SKIPPED',
          })
        ) {
          return { idempotent: true, session: loaded };
        }

        const session = reconcileExpiredActiveSession(
          db,
          loaded,
          nowMs,
          sessionRepo,
          eventLogRepo,
          statsRepo
        );

        if (session.status !== 'active' && session.status !== 'paused') {
          throw new AppError(
            409,
            'INVALID_SESSION_STATE',
            `Cannot skip phase in '${session.status}' state`
          );
        }

        const { effectiveIndex: currentIdx, accumulatedPauseMs } = resolveSessionMetricsAt(
          session,
          nowMs
        );

        const nextIndex = currentIdx + 1;
        const isFinished = nextIndex >= session.plan.length;

        const updated: Session = isFinished
          ? {
              ...session,
              status: 'completed',
              currentIndex: session.plan.length,
              accumulatedPauseMs,
              pausedAt: null,
              endedAt: nowMs,
              version: session.version + 1,
              updatedAt: nowMs,
            }
          : {
              ...session,
              status: 'active',
              plan: reanchorPlanFromIndex(session.plan, nextIndex, nowMs),
              currentIndex: nextIndex,
              accumulatedPauseMs,
              pausedAt: null,
              version: session.version + 1,
              updatedAt: nowMs,
            };

        sessionRepo.update(updated, session.version);
        if (isFinished) {
          statsRepo.recordCompletedSession({
            userId,
            sessionId: updated.id,
            plan: updated.plan,
            reachedIndex: currentIdx,
            endedAt: nowMs,
            skippedFinal: true,
            nowMs,
          });
        }
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: updated.id,
          eventType: 'PHASE_SKIPPED',
          payload: {
            skippedIndex: currentIdx,
            nextIndex: updated.currentIndex,
            completed: isFinished,
            version: updated.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { idempotent: false, session: updated };
      })();

      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Resets (aborts/invalidates) an active or paused session.
   */
  router.post('/:id/reset', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();

      const result = db.transaction(() => {
        const loaded = loadOwnedSession(sessionRepo, id, userId);
        if (
          isIdempotentControlReplay(eventLogRepo, {
            eventId: body.eventId,
            userId,
            sessionId: loaded.id,
            eventType: 'SESSION_RESET',
          })
        ) {
          return { idempotent: true, session: loaded };
        }

        const session = reconcileExpiredActiveSession(
          db,
          loaded,
          nowMs,
          sessionRepo,
          eventLogRepo,
          statsRepo
        );

        if (session.status !== 'active' && session.status !== 'paused') {
          throw new AppError(
            409,
            'INVALID_SESSION_STATE',
            `Cannot reset session in '${session.status}' state`
          );
        }

        const { effectiveIndex, accumulatedPauseMs } = resolveSessionMetricsAt(session, nowMs);
        const updated: Session = {
          ...session,
          status: 'reset',
          currentIndex: effectiveIndex,
          accumulatedPauseMs,
          pausedAt: null,
          endedAt: nowMs,
          version: session.version + 1,
          updatedAt: nowMs,
        };

        sessionRepo.update(updated, session.version);
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: updated.id,
          eventType: 'SESSION_RESET',
          payload: {
            currentIndex: updated.currentIndex,
            version: updated.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { idempotent: false, session: updated };
      })();

      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Ends an active or paused session as completed.
   */
  router.post('/:id/end', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();

      const result = db.transaction(() => {
        const loaded = loadOwnedSession(sessionRepo, id, userId);
        if (
          isIdempotentControlReplay(eventLogRepo, {
            eventId: body.eventId,
            userId,
            sessionId: loaded.id,
            eventType: 'SESSION_ENDED',
          })
        ) {
          return { idempotent: true, session: loaded };
        }

        const session = reconcileExpiredActiveSession(
          db,
          loaded,
          nowMs,
          sessionRepo,
          eventLogRepo,
          statsRepo
        );

        if (session.status !== 'active' && session.status !== 'paused') {
          throw new AppError(
            409,
            'INVALID_SESSION_STATE',
            `Cannot end session in '${session.status}' state`
          );
        }

        const { effectiveIndex, accumulatedPauseMs } = resolveSessionMetricsAt(session, nowMs);
        const updated: Session = {
          ...session,
          status: 'completed',
          currentIndex: effectiveIndex,
          accumulatedPauseMs,
          pausedAt: null,
          endedAt: nowMs,
          version: session.version + 1,
          updatedAt: nowMs,
        };

        sessionRepo.update(updated, session.version);
        statsRepo.recordCompletedSession({
          userId,
          sessionId: updated.id,
          plan: updated.plan,
          reachedIndex: effectiveIndex,
          endedAt: nowMs,
          skippedFinal: false,
          nowMs,
        });
        eventLogRepo.append({
          eventId: body.eventId,
          userId,
          entityType: 'session',
          entityId: updated.id,
          eventType: 'SESSION_ENDED',
          payload: {
            currentIndex: updated.currentIndex,
            accumulatedPauseMs: updated.accumulatedPauseMs,
            version: updated.version,
          },
          clientTimestamp: body.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });

        return { idempotent: false, session: updated };
      })();

      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
