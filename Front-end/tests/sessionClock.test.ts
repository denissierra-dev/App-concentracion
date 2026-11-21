import { describe, expect, it } from 'vitest';
import {
  applyOfflineSessionControl,
  deriveTimerSnapshot,
  formatDurationMs,
  previewBreakRules,
} from '../src/domain/sessionClock';
import type { Session } from '../src/domain/types';

const BASE_TIME = 1_700_000_000_000;

function makeActiveSession(): Session {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    currentIndex: 0,
    startedAt: BASE_TIME,
    accumulatedPauseMs: 0,
    pausedAt: null,
    endedAt: null,
    version: 1,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    plan: [
      {
        index: 0,
        cycleNumber: 1,
        phaseType: 'focus',
        durationMs: 25 * 60_000,
        startsAt: BASE_TIME,
        endsAt: BASE_TIME + 25 * 60_000,
      },
      {
        index: 1,
        cycleNumber: 1,
        phaseType: 'short_break',
        durationMs: 5 * 60_000,
        startsAt: BASE_TIME + 25 * 60_000,
        endsAt: BASE_TIME + 30 * 60_000,
      },
    ],
  };
}

describe('Local Session Clock Projection (Back-end First)', () => {
  it('transitions locally across precomputed phases as serverNowMs advances', () => {
    const session = makeActiveSession();

    const midFocus = deriveTimerSnapshot(session, BASE_TIME + 10 * 60_000);
    expect(midFocus?.effectiveIndex).toBe(0);
    expect(midFocus?.currentPhase?.phaseType).toBe('focus');
    expect(midFocus?.remainingMs).toBe(15 * 60_000);
    expect(midFocus?.isPlanCompleted).toBe(false);

    const inBreak = deriveTimerSnapshot(session, BASE_TIME + 26 * 60_000);
    expect(inBreak?.effectiveIndex).toBe(1);
    expect(inBreak?.currentPhase?.phaseType).toBe('short_break');
    expect(inBreak?.remainingMs).toBe(4 * 60_000);
    expect(inBreak?.isPlanCompleted).toBe(false);

    const finished = deriveTimerSnapshot(session, BASE_TIME + 31 * 60_000);
    expect(finished?.isPlanCompleted).toBe(true);
    expect(finished?.currentPhase).toBeNull();
  });

  it('freezes remaining time when paused', () => {
    const session: Session = {
      ...makeActiveSession(),
      status: 'paused',
      pausedAt: BASE_TIME + 5 * 60_000,
    };

    const snap = deriveTimerSnapshot(session, BASE_TIME + 20 * 60_000);
    expect(snap?.remainingMs).toBe(20 * 60_000);
    expect(snap?.currentPhase?.phaseType).toBe('focus');
  });

  it('formats durations and previews backend break rules accurately', () => {
    expect(formatDurationMs(25 * 60_000)).toBe('25:00');
    expect(formatDurationMs(65 * 60_000)).toBe('1:05:00');

    expect(previewBreakRules(25).shortBreakMin).toBe(5);
    expect(previewBreakRules(40).shortBreakMin).toBe(5);
    expect(previewBreakRules(45).shortBreakMin).toBe(10);

    const custom = previewBreakRules(25, 3, 8, 25);
    expect(custom.shortBreakMin).toBe(8);
    expect(custom.longBreakMin).toBe(25);
    expect(custom.cyclesBeforeLongBreak).toBe(3);
    expect(custom.isCustomShortBreak).toBe(true);

    // Server rule: long_break = max(longBreakMin, 2 * short_break)
    const enforcedOnExtendedFocus = previewBreakRules(60, 4, 5, 10);
    expect(enforcedOnExtendedFocus.shortBreakMin).toBe(10);
    expect(enforcedOnExtendedFocus.longBreakMin).toBe(20);

    const enforcedOnCustomShort = previewBreakRules(25, 4, 35, 50);
    expect(enforcedOnCustomShort.shortBreakMin).toBe(35);
    expect(enforcedOnCustomShort.longBreakMin).toBe(70);
  });

  it('keeps active session and advances phase on offline non-final PHASE_SKIPPED', () => {
    const session = makeActiveSession();
    const skipTime = BASE_TIME + 5 * 60_000;

    const afterSkipFirst = applyOfflineSessionControl(session, 'PHASE_SKIPPED', skipTime);
    expect(afterSkipFirst).not.toBeNull();
    expect(afterSkipFirst?.currentIndex).toBe(1);
    expect(afterSkipFirst?.status).toBe('active');
    expect(afterSkipFirst?.version).toBe(2);
    expect(afterSkipFirst?.plan[1]?.startsAt).toBe(skipTime);
    expect(afterSkipFirst?.plan[1]?.endsAt).toBe(skipTime + 5 * 60_000);

    // Skipping the final phase closes the session
    const afterSkipFinal = applyOfflineSessionControl(afterSkipFirst!, 'PHASE_SKIPPED', skipTime + 1000);
    expect(afterSkipFinal).toBeNull();

    // Pause and resume offline preserve version chain and shift future endsAt
    const paused = applyOfflineSessionControl(session, 'SESSION_PAUSED', BASE_TIME + 60_000);
    expect(paused?.status).toBe('paused');
    expect(paused?.version).toBe(2);

    const resumed = applyOfflineSessionControl(paused!, 'SESSION_RESUMED', BASE_TIME + 180_000);
    expect(resumed?.status).toBe('active');
    expect(resumed?.version).toBe(3);
    expect(resumed?.accumulatedPauseMs).toBe(120_000);
    expect(resumed?.plan[0]?.endsAt).toBe(BASE_TIME + 25 * 60_000 + 120_000);
  });
});
