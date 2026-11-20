import type { PhaseType, SessionPlanPhase } from '../domain/types.js';

export const SESSION_LIMITS = {
  MIN_FOCUS_MIN: 5,
  MAX_FOCUS_MIN: 180,
  MIN_CYCLES: 1,
  MAX_CYCLES: 12,
  CYCLES_BEFORE_LONG_BREAK: 4,
  SHORT_BREAK_STANDARD_MIN: 5,
  SHORT_BREAK_EXTENDED_MIN: 10,
  LONG_BREAK_MIN: 20,
  EXTENDED_FOCUS_THRESHOLD_MIN: 40,
} as const;

export interface BuildPlanInput {
  focusDurationMin: number;
  totalCycles: number;
  startedAt: number;
  cyclesBeforeLongBreak?: number;
}

/**
 * Computes break type and duration according to roadmap Phase 2 rules:
 * - 25-40 min focus -> 5 min short break (also 5 min for <25 min)
 * - >40 min focus -> 10 min short break
 * - Every 4th cycle -> 20 min long break
 */
export function resolveBreakForCycle(
  focusDurationMin: number,
  cycleNumber: number,
  cyclesBeforeLongBreak: number = SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK
): { phaseType: Extract<PhaseType, 'short_break' | 'long_break'>; durationMin: number } {
  if (cycleNumber % cyclesBeforeLongBreak === 0) {
    return {
      phaseType: 'long_break',
      durationMin: SESSION_LIMITS.LONG_BREAK_MIN,
    };
  }

  const durationMin =
    focusDurationMin > SESSION_LIMITS.EXTENDED_FOCUS_THRESHOLD_MIN
      ? SESSION_LIMITS.SHORT_BREAK_EXTENDED_MIN
      : SESSION_LIMITS.SHORT_BREAK_STANDARD_MIN;

  return {
    phaseType: 'short_break',
    durationMin,
  };
}

/**
 * Generates the complete precomputed session plan (focus + break phases)
 * in a single deterministic sequence so the front-end never needs per-phase round-trips.
 */
export function buildSessionPlan(input: BuildPlanInput): SessionPlanPhase[] {
  const {
    focusDurationMin,
    totalCycles,
    startedAt,
    cyclesBeforeLongBreak = SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK,
  } = input;

  const phases: SessionPlanPhase[] = [];
  let cursorMs = startedAt;
  let index = 0;

  for (let cycleNumber = 1; cycleNumber <= totalCycles; cycleNumber++) {
    const focusDurationMs = focusDurationMin * 60_000;
    phases.push({
      index,
      cycleNumber,
      phaseType: 'focus',
      durationMs: focusDurationMs,
      startsAt: cursorMs,
      endsAt: cursorMs + focusDurationMs,
    });
    cursorMs += focusDurationMs;
    index++;

    const breakSpec = resolveBreakForCycle(
      focusDurationMin,
      cycleNumber,
      cyclesBeforeLongBreak
    );
    const breakDurationMs = breakSpec.durationMin * 60_000;
    phases.push({
      index,
      cycleNumber,
      phaseType: breakSpec.phaseType,
      durationMs: breakDurationMs,
      startsAt: cursorMs,
      endsAt: cursorMs + breakDurationMs,
    });
    cursorMs += breakDurationMs;
    index++;
  }

  return phases;
}

/**
 * Shifts `endsAt` for the active phase (`fromIndex`, since it has already started)
 * and shifts both `startsAt` and `endsAt` for subsequent phases (`idx > fromIndex`).
 */
export function shiftPlanFromIndex(
  plan: SessionPlanPhase[],
  fromIndex: number,
  deltaMs: number
): SessionPlanPhase[] {
  return plan.map((phase, idx) => {
    if (idx < fromIndex) {
      return phase;
    }
    if (idx === fromIndex) {
      return {
        ...phase,
        endsAt: phase.endsAt + deltaMs,
      };
    }
    return {
      ...phase,
      startsAt: phase.startsAt + deltaMs,
      endsAt: phase.endsAt + deltaMs,
    };
  });
}

/**
 * Re-anchors `fromIndex` and all subsequent phases to start sequentially from `anchorMs`.
 */
export function reanchorPlanFromIndex(
  plan: SessionPlanPhase[],
  fromIndex: number,
  anchorMs: number
): SessionPlanPhase[] {
  let cursorMs = anchorMs;
  return plan.map((phase, idx) => {
    if (idx < fromIndex) {
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
}

/**
 * Derives the current phase index for an active session based on authoritative server time.
 * Returns plan.length if all phases have elapsed.
 */
export function computeCurrentIndexAt(
  plan: SessionPlanPhase[],
  minIndex: number,
  nowMs: number
): number {
  for (let i = Math.max(0, minIndex); i < plan.length; i++) {
    const phase = plan[i];
    if (phase && nowMs < phase.endsAt) {
      return i;
    }
  }
  return plan.length;
}
