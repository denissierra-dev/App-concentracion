import type { PhaseType, Session, SessionPlanPhase } from './types';
import { SESSION_LIMITS } from '../security/validators';

export interface DerivedTimerSnapshot {
  effectiveIndex: number;
  currentPhase: SessionPlanPhase | null;
  remainingMs: number;
  elapsedMs: number;
  progressRatio: number;
  isPlanCompleted: boolean;
  totalPhases: number;
}

/**
 * Pure local projection of the authoritative session plan at `serverNowMs`.
 * Mirrors `computeCurrentIndexAt` on the back-end so phases transition locally
 * with zero per-phase HTTP round-trips.
 */
export function deriveTimerSnapshot(
  session: Session | null,
  serverNowMs: number
): DerivedTimerSnapshot | null {
  if (!session || session.plan.length === 0) {
    return null;
  }

  const totalPhases = session.plan.length;

  if (session.status === 'completed' || session.status === 'reset') {
    return {
      effectiveIndex: totalPhases,
      currentPhase: null,
      remainingMs: 0,
      elapsedMs: 0,
      progressRatio: 1,
      isPlanCompleted: true,
      totalPhases,
    };
  }

  if (session.status === 'paused') {
    const phase = session.plan[session.currentIndex] ?? null;
    if (!phase) {
      return {
        effectiveIndex: totalPhases,
        currentPhase: null,
        remainingMs: 0,
        elapsedMs: 0,
        progressRatio: 1,
        isPlanCompleted: true,
        totalPhases,
      };
    }

    const referenceNow = session.pausedAt ?? serverNowMs;
    const remainingMs = Math.max(0, Math.min(phase.durationMs, phase.endsAt - referenceNow));
    const elapsedMs = Math.max(0, phase.durationMs - remainingMs);
    const progressRatio = phase.durationMs > 0 ? Math.min(1, elapsedMs / phase.durationMs) : 0;

    return {
      effectiveIndex: session.currentIndex,
      currentPhase: phase,
      remainingMs,
      elapsedMs,
      progressRatio,
      isPlanCompleted: false,
      totalPhases,
    };
  }

  // Active session: advance locally across precomputed phases as serverNowMs crosses endsAt
  let effectiveIndex = totalPhases;
  for (let i = Math.max(0, session.currentIndex); i < totalPhases; i++) {
    const phase = session.plan[i];
    if (phase && serverNowMs < phase.endsAt) {
      effectiveIndex = i;
      break;
    }
  }

  if (effectiveIndex >= totalPhases) {
    return {
      effectiveIndex: totalPhases,
      currentPhase: null,
      remainingMs: 0,
      elapsedMs: 0,
      progressRatio: 1,
      isPlanCompleted: true,
      totalPhases,
    };
  }

  const currentPhase = session.plan[effectiveIndex]!;
  const remainingMs = Math.max(0, currentPhase.endsAt - serverNowMs);
  const elapsedMs = Math.max(0, currentPhase.durationMs - remainingMs);
  const progressRatio =
    currentPhase.durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / currentPhase.durationMs)) : 0;

  return {
    effectiveIndex,
    currentPhase,
    remainingMs,
    elapsedMs,
    progressRatio,
    isPlanCompleted: false,
    totalPhases,
  };
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function getPhaseLabel(phaseType: PhaseType): string {
  switch (phaseType) {
    case 'focus':
      return 'Enfoque';
    case 'short_break':
      return 'Descanso corto';
    case 'long_break':
      return 'Descanso largo';
  }
}

export function previewBreakRules(
  focusDurationMin: number,
  cyclesBeforeLongBreak: number = SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK
): { shortBreakMin: number; longBreakMin: number; cyclesBeforeLongBreak: number } {
  const shortBreakMin =
    focusDurationMin > SESSION_LIMITS.EXTENDED_FOCUS_THRESHOLD_MIN
      ? SESSION_LIMITS.SHORT_BREAK_EXTENDED_MIN
      : SESSION_LIMITS.SHORT_BREAK_STANDARD_MIN;

  return {
    shortBreakMin,
    longBreakMin: SESSION_LIMITS.LONG_BREAK_MIN,
    cyclesBeforeLongBreak,
  };
}

/**
 * Optimistically applies a session control event locally when offline
 * so skipping a non-final phase advances to the next phase instead of clearing the timer.
 */
export function applyOfflineSessionControl(
  session: Session,
  eventType:
    | 'SESSION_PAUSED'
    | 'SESSION_RESUMED'
    | 'PHASE_SKIPPED'
    | 'SESSION_RESET'
    | 'SESSION_ENDED',
  nowMs: number
): Session | null {
  if (eventType === 'SESSION_RESET' || eventType === 'SESSION_ENDED') {
    return null;
  }

  const snapshot = deriveTimerSnapshot(session, nowMs);
  const effectiveIndex = snapshot ? snapshot.effectiveIndex : session.currentIndex;

  if (eventType === 'SESSION_PAUSED') {
    if (session.status !== 'active' || effectiveIndex >= session.plan.length) {
      return session;
    }
    return {
      ...session,
      status: 'paused',
      currentIndex: effectiveIndex,
      pausedAt: nowMs,
      version: session.version + 1,
      updatedAt: nowMs,
    };
  }

  if (eventType === 'SESSION_RESUMED') {
    if (session.status !== 'paused' || session.pausedAt === null) {
      return session;
    }
    const pauseDeltaMs = Math.max(0, nowMs - session.pausedAt);
    const shiftedPlan = session.plan.map((phase, idx) => {
      if (idx < session.currentIndex) return phase;
      if (idx === session.currentIndex) {
        return { ...phase, endsAt: phase.endsAt + pauseDeltaMs };
      }
      return {
        ...phase,
        startsAt: phase.startsAt + pauseDeltaMs,
        endsAt: phase.endsAt + pauseDeltaMs,
      };
    });
    return {
      ...session,
      status: 'active',
      plan: shiftedPlan,
      accumulatedPauseMs: session.accumulatedPauseMs + pauseDeltaMs,
      pausedAt: null,
      version: session.version + 1,
      updatedAt: nowMs,
    };
  }

  // PHASE_SKIPPED
  const nextIndex = effectiveIndex + 1;
  if (nextIndex >= session.plan.length) {
    return null;
  }

  let cursorMs = nowMs;
  const reanchoredPlan = session.plan.map((phase, idx) => {
    if (idx < nextIndex) {
      return phase;
    }
    const updated: SessionPlanPhase = {
      ...phase,
      startsAt: cursorMs,
      endsAt: cursorMs + phase.durationMs,
    };
    cursorMs += phase.durationMs;
    return updated;
  });

  return {
    ...session,
    status: 'active',
    plan: reanchoredPlan,
    currentIndex: nextIndex,
    pausedAt: null,
    version: session.version + 1,
    updatedAt: nowMs,
  };
}
