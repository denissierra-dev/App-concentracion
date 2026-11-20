import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { Session } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { EventLogRepository } from '../repositories/eventLogRepository.js';
import type { SessionRepository } from '../repositories/sessionRepository.js';
import type { StatsRepository } from '../repositories/statsRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import {
  buildSessionPlan,
  computeCurrentIndexAt,
  reanchorPlanFromIndex,
  SESSION_LIMITS,
  shiftPlanFromIndex,
} from './sessionPlanner.js';

export interface SessionServiceDeps {
  db: AppDatabase;
  sessionRepo: SessionRepository;
  userRepo: UserRepository;
  eventLogRepo: EventLogRepository;
  statsRepo: StatsRepository;
}

export interface CreateSessionParams {
  userId: string;
  sessionId?: string;
  focusDurationMin?: number;
  shortBreakMin?: number;
  longBreakMin?: number;
  totalCycles?: number;
  eventId?: string;
  clientTimestamp?: number;
  nowMs?: number;
}

export interface ControlSessionParams {
  userId: string;
  sessionId: string;
  eventId?: string;
  expectedVersion?: number;
  clientTimestamp?: number;
  nowMs?: number;
}

function assertExpectedVersion(session: Session, expectedVersion?: number): void {
  if (expectedVersion !== undefined && session.version !== expectedVersion) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      `Version mismatch: expected ${expectedVersion}, server is at ${session.version}`,
      { serverVersion: session.version, serverStatus: session.status }
    );
  }
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

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  reconcileExpiredActiveSession(session: Session, nowMs: number = Date.now()): Session {
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

    return this.deps.db.transaction(() => {
      this.deps.sessionRepo.update(completed, session.version);
      this.deps.statsRepo.recordCompletedSession({
        userId: completed.userId,
        sessionId: completed.id,
        plan: completed.plan,
        reachedIndex: completed.plan.length - 1,
        endedAt: lastPhase.endsAt,
        skippedFinal: false,
        nowMs,
      });
      this.deps.eventLogRepo.append({
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

  createSession(params: CreateSessionParams): { created: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();
    const totalCycles = params.totalCycles ?? SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK;

    return this.deps.db.transaction(() => {
      if (params.eventId) {
        const existingEvent = this.deps.eventLogRepo.findByEventIdForUser(
          params.eventId,
          params.userId
        );
        if (existingEvent) {
          if (
            existingEvent.entityType !== 'session' ||
            existingEvent.eventType !== 'SESSION_STARTED' ||
            (params.sessionId !== undefined && existingEvent.entityId !== params.sessionId)
          ) {
            throw new AppError(
              409,
              'EVENT_ID_CONFLICT',
              'Event ID was already used for a different action'
            );
          }
          const existingByEvent = this.deps.sessionRepo.findByIdForUser(
            existingEvent.entityId,
            params.userId
          );
          if (existingByEvent) {
            return { created: false, session: existingByEvent };
          }
        }
      }

      if (params.sessionId) {
        const existing = this.deps.sessionRepo.findByIdForUser(params.sessionId, params.userId);
        if (existing) {
          return { created: false, session: existing };
        }
        if (this.deps.sessionRepo.existsById(params.sessionId)) {
          throw new AppError(409, 'SESSION_ID_CONFLICT', 'Session ID is already in use');
        }
      }

      const inProgress = this.deps.sessionRepo.findCurrentByUser(params.userId);
      if (inProgress) {
        const reconciled = this.reconcileExpiredActiveSession(inProgress, nowMs);
        if (reconciled.status === 'active' || reconciled.status === 'paused') {
          throw new AppError(
            409,
            'ACTIVE_SESSION_EXISTS',
            'An active or paused session already exists for this user',
            { activeSessionId: reconciled.id, status: reconciled.status }
          );
        }
      }

      const prefs = this.deps.userRepo.getPreferencesByUserId(params.userId);
      const focusDurationMin = params.focusDurationMin ?? prefs?.focusDurationMin ?? 25;
      const shortBreakMin = params.shortBreakMin ?? prefs?.shortBreakMin;
      const longBreakMin = params.longBreakMin ?? prefs?.longBreakMin;
      const cyclesBeforeLongBreak =
        prefs?.cyclesBeforeLongBreak ?? SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK;

      const sessionId = params.sessionId ?? crypto.randomUUID();
      const plan = buildSessionPlan({
        focusDurationMin,
        totalCycles,
        startedAt: nowMs,
        cyclesBeforeLongBreak,
        shortBreakMin,
        longBreakMin,
      });

      const session: Session = {
        id: sessionId,
        userId: params.userId,
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

      this.deps.sessionRepo.create(session);
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: session.id,
        eventType: 'SESSION_STARTED',
        payload: {
          focusDurationMin,
          totalCycles,
          version: session.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { created: true, session };
    })();
  }

  getActiveSessionState(
    userId: string,
    nowMs: number = Date.now()
  ): { session: Session | null; currentPhase: Session['plan'][number] | null } {
    const current = this.deps.sessionRepo.findCurrentByUser(userId);
    if (!current) {
      return { session: null, currentPhase: null };
    }

    const session = this.reconcileExpiredActiveSession(current, nowMs);
    if (session.status !== 'active' && session.status !== 'paused') {
      return { session: null, currentPhase: null };
    }

    const effectiveIndex =
      session.status === 'active'
        ? computeCurrentIndexAt(session.plan, session.currentIndex, nowMs)
        : session.currentIndex;

    return {
      session: {
        ...session,
        currentIndex: effectiveIndex,
      },
      currentPhase: session.plan[effectiveIndex] ?? null,
    };
  }

  getSessionState(
    userId: string,
    sessionId: string,
    nowMs: number = Date.now()
  ): { session: Session; currentPhase: Session['plan'][number] | null } {
    const session = this.reconcileExpiredActiveSession(
      loadOwnedSession(this.deps.sessionRepo, sessionId, userId),
      nowMs
    );

    const effectiveIndex =
      session.status === 'active'
        ? computeCurrentIndexAt(session.plan, session.currentIndex, nowMs)
        : session.currentIndex;

    return {
      session: {
        ...session,
        currentIndex: effectiveIndex,
      },
      currentPhase: session.plan[effectiveIndex] ?? null,
    };
  }

  pauseSession(params: ControlSessionParams): { idempotent: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const loaded = loadOwnedSession(this.deps.sessionRepo, params.sessionId, params.userId);
      if (
        isIdempotentControlReplay(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          sessionId: loaded.id,
          eventType: 'SESSION_PAUSED',
        })
      ) {
        return { idempotent: true, session: loaded };
      }

      const session = this.reconcileExpiredActiveSession(loaded, nowMs);
      assertExpectedVersion(session, params.expectedVersion);

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

      this.deps.sessionRepo.update(updated, session.version);
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: updated.id,
        eventType: 'SESSION_PAUSED',
        payload: {
          currentIndex: updated.currentIndex,
          version: updated.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, session: updated };
    })();
  }

  resumeSession(params: ControlSessionParams): { idempotent: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const session = loadOwnedSession(this.deps.sessionRepo, params.sessionId, params.userId);
      if (
        isIdempotentControlReplay(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          sessionId: session.id,
          eventType: 'SESSION_RESUMED',
        })
      ) {
        return { idempotent: true, session };
      }

      assertExpectedVersion(session, params.expectedVersion);

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

      this.deps.sessionRepo.update(updated, session.version);
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: updated.id,
        eventType: 'SESSION_RESUMED',
        payload: {
          pauseDeltaMs,
          accumulatedPauseMs: updated.accumulatedPauseMs,
          version: updated.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, session: updated };
    })();
  }

  skipPhase(params: ControlSessionParams): { idempotent: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const loaded = loadOwnedSession(this.deps.sessionRepo, params.sessionId, params.userId);
      if (
        isIdempotentControlReplay(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          sessionId: loaded.id,
          eventType: 'PHASE_SKIPPED',
        })
      ) {
        return { idempotent: true, session: loaded };
      }

      const session = this.reconcileExpiredActiveSession(loaded, nowMs);
      assertExpectedVersion(session, params.expectedVersion);

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

      this.deps.sessionRepo.update(updated, session.version);
      if (isFinished) {
        this.deps.statsRepo.recordCompletedSession({
          userId: params.userId,
          sessionId: updated.id,
          plan: updated.plan,
          reachedIndex: currentIdx,
          endedAt: nowMs,
          skippedFinal: true,
          nowMs,
        });
      }
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: updated.id,
        eventType: 'PHASE_SKIPPED',
        payload: {
          skippedIndex: currentIdx,
          nextIndex: updated.currentIndex,
          completed: isFinished,
          version: updated.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, session: updated };
    })();
  }

  resetSession(params: ControlSessionParams): { idempotent: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const loaded = loadOwnedSession(this.deps.sessionRepo, params.sessionId, params.userId);
      if (
        isIdempotentControlReplay(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          sessionId: loaded.id,
          eventType: 'SESSION_RESET',
        })
      ) {
        return { idempotent: true, session: loaded };
      }

      const session = this.reconcileExpiredActiveSession(loaded, nowMs);
      assertExpectedVersion(session, params.expectedVersion);

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

      this.deps.sessionRepo.update(updated, session.version);
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: updated.id,
        eventType: 'SESSION_RESET',
        payload: {
          currentIndex: updated.currentIndex,
          version: updated.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, session: updated };
    })();
  }

  endSession(params: ControlSessionParams): { idempotent: boolean; session: Session } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const loaded = loadOwnedSession(this.deps.sessionRepo, params.sessionId, params.userId);
      if (
        isIdempotentControlReplay(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          sessionId: loaded.id,
          eventType: 'SESSION_ENDED',
        })
      ) {
        return { idempotent: true, session: loaded };
      }

      const session = this.reconcileExpiredActiveSession(loaded, nowMs);
      assertExpectedVersion(session, params.expectedVersion);

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

      this.deps.sessionRepo.update(updated, session.version);
      this.deps.statsRepo.recordCompletedSession({
        userId: params.userId,
        sessionId: updated.id,
        plan: updated.plan,
        reachedIndex: effectiveIndex,
        endedAt: nowMs,
        skippedFinal: false,
        nowMs,
      });
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'session',
        entityId: updated.id,
        eventType: 'SESSION_ENDED',
        payload: {
          currentIndex: updated.currentIndex,
          accumulatedPauseMs: updated.accumulatedPauseMs,
          version: updated.version,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, session: updated };
    })();
  }
}
