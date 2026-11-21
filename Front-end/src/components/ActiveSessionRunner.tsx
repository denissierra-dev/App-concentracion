import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { deriveTimerSnapshot } from '../domain/sessionClock';
import type { PhaseType, Session } from '../domain/types';
import { TimerDisplay } from './TimerDisplay';

interface ActiveSessionRunnerProps {
  session: Session;
  clockOffsetMs: number;
  isBusy: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSkip: () => Promise<void>;
  onEnd: () => Promise<void>;
  onReset: () => Promise<void>;
  onSyncState: () => Promise<void>;
  onPhaseTransition: (event: {
    phaseType: PhaseType | null;
    isTransition: boolean;
    isPlanCompleted: boolean;
    cycleNumber: number | null;
  }) => void;
  onPlanCompleted: (sessionId: string) => void;
  onOpenTimeline?: () => void;
}

export const ActiveSessionRunner = memo(function ActiveSessionRunner({
  session,
  clockOffsetMs,
  isBusy,
  onPause,
  onResume,
  onSkip,
  onEnd,
  onReset,
  onSyncState,
  onPhaseTransition,
  onPlanCompleted,
  onOpenTimeline,
}: ActiveSessionRunnerProps) {
  const [tickNowMs, setTickNowMs] = useState<number>(() => Date.now() + clockOffsetMs);
  const prevPhaseKeyRef = useRef<string | null>(null);
  const lastReportedPhaseTypeRef = useRef<PhaseType | null | undefined>(undefined);
  const completedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    setTickNowMs(Date.now() + clockOffsetMs);
    if (session.status !== 'active') {
      return;
    }

    const intervalId = window.setInterval(() => {
      setTickNowMs(Date.now() + clockOffsetMs);
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [session, clockOffsetMs]);

  const snapshot = useMemo(
    () => deriveTimerSnapshot(session, tickNowMs),
    [session, tickNowMs]
  );

  useEffect(() => {
    if (!snapshot) {
      prevPhaseKeyRef.current = null;
      return;
    }

    const phaseType = snapshot.currentPhase?.phaseType ?? null;
    const currentKey = snapshot.isPlanCompleted
      ? `${session.id}:done`
      : `${session.id}:${session.version}:${snapshot.effectiveIndex}`;

    const previousKey = prevPhaseKeyRef.current;
    prevPhaseKeyRef.current = currentKey;

    const isTransition = Boolean(
      previousKey && previousKey !== currentKey && session.status === 'active'
    );

    if (isTransition || lastReportedPhaseTypeRef.current !== phaseType) {
      lastReportedPhaseTypeRef.current = phaseType;
      onPhaseTransition({
        phaseType,
        isTransition,
        isPlanCompleted: snapshot.isPlanCompleted,
        cycleNumber: snapshot.currentPhase?.cycleNumber ?? null,
      });
    }

    if (
      session.status === 'active' &&
      snapshot.isPlanCompleted &&
      completedSessionIdRef.current !== session.id
    ) {
      completedSessionIdRef.current = session.id;
      onPlanCompleted(session.id);
    }
  }, [session, snapshot, onPhaseTransition, onPlanCompleted]);

  if (!snapshot) {
    return null;
  }

  return (
    <TimerDisplay
      session={session}
      snapshot={snapshot}
      isBusy={isBusy}
      onPause={onPause}
      onResume={onResume}
      onSkip={onSkip}
      onEnd={onEnd}
      onReset={onReset}
      onSyncState={onSyncState}
      onOpenTimeline={onOpenTimeline}
    />
  );
});
