import { memo, useState } from 'react';
import {
  formatDurationMs,
  getPhaseLabel,
  type DerivedTimerSnapshot,
} from '../domain/sessionClock';
import type { Session } from '../domain/types';

interface TimerDisplayProps {
  session: Session;
  snapshot: DerivedTimerSnapshot;
  isBusy: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSkip: () => Promise<void>;
  onEnd: () => Promise<void>;
  onReset: () => Promise<void>;
  onSyncState?: () => Promise<void>;
  onOpenTimeline?: () => void;
}

const RING_RADIUS = 108;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const TimerDisplay = memo(function TimerDisplay({
  session,
  snapshot,
  isBusy,
  onPause,
  onResume,
  onSkip,
  onEnd,
  onReset,
  onOpenTimeline,
}: TimerDisplayProps) {
  const [confirmReset, setConfirmReset] = useState(false);

  const phase = snapshot.currentPhase;
  const totalCycles = session.plan.reduce((acc, item) => Math.max(acc, item.cycleNumber), 1);
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - snapshot.progressRatio);

  const phaseBadgeClass =
    phase?.phaseType === 'focus'
      ? 'bg-brand text-brand-ink'
      : phase?.phaseType === 'long_break'
        ? 'bg-long-break text-long-break-ink'
        : 'bg-break text-break-ink';

  const ringStrokeClass =
    phase?.phaseType === 'focus'
      ? 'stroke-brand'
      : phase?.phaseType === 'long_break'
        ? 'stroke-long-break'
        : 'stroke-break';

  return (
    <section
      className="liquid-glass liquid-stage-enter rounded-3xl p-6 sm:p-8"
      aria-label="Cronómetro de concentración"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3.5 py-1 text-xs font-semibold shadow-sm ${phaseBadgeClass}`}
          >
            {phase ? getPhaseLabel(phase.phaseType) : 'Sesión finalizada'}
          </span>
          {phase && (
            <span className="liquid-glass-subtle inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold text-ink">
              Ciclo {phase.cycleNumber} / {totalCycles}
            </span>
          )}
          {session.status === 'paused' && (
            <span className="inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-bold text-accent-ink">
              En pausa
            </span>
          )}
        </div>

        {onOpenTimeline && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="liquid-pill cursor-pointer rounded-full px-3 py-1 text-xs font-semibold text-heading"
              onClick={onOpenTimeline}
            >
              Fases
            </button>
          </div>
        )}
      </div>

      <div className="liquid-ring-enter relative mx-auto my-7 h-60 w-60 sm:my-8 sm:h-68 sm:w-68">
        <div
          className="liquid-glass-subtle pointer-events-none absolute inset-4 rounded-full"
          aria-hidden="true"
        />
        <svg
          className="relative h-full w-full -rotate-90"
          viewBox="0 0 240 240"
          role="img"
          aria-label={`Tiempo restante ${formatDurationMs(snapshot.remainingMs)}`}
        >
          <circle
            className="fill-none stroke-elevated/60 stroke-[10]"
            cx="120"
            cy="120"
            r={RING_RADIUS}
          />
          <circle
            className={`fill-none stroke-[10] transition-[stroke-dashoffset] duration-200 ease-linear ${ringStrokeClass}`}
            cx="120"
            cy="120"
            r={RING_RADIUS}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-5xl font-extrabold tracking-tight tabular-nums text-heading sm:text-6xl">
            {formatDurationMs(snapshot.remainingMs)}
          </span>
          <span className="mt-1.5 text-xs font-medium text-muted">
            {phase
              ? `Fase ${snapshot.effectiveIndex + 1} de ${snapshot.totalPhases}`
              : 'Plan completado'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-2.5">
        {session.status === 'active' && !snapshot.isPlanCompleted && (
          <button
            type="button"
            className="min-h-11 cursor-pointer rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-brand-ink shadow-sm transition hover:bg-brand-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onPause}
            disabled={isBusy}
          >
            Pausar
          </button>
        )}

        {session.status === 'paused' && (
          <button
            type="button"
            className="min-h-11 cursor-pointer rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-accent-ink shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onResume}
            disabled={isBusy}
          >
            Reanudar
          </button>
        )}

        {!snapshot.isPlanCompleted && (
          <button
            type="button"
            className="liquid-pill min-h-11 cursor-pointer rounded-full px-4 py-2.5 text-sm font-semibold text-heading disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onSkip}
            disabled={isBusy}
          >
            Saltar fase
          </button>
        )}

        <button
          type="button"
          className="liquid-pill min-h-11 cursor-pointer rounded-full px-4 py-2.5 text-sm font-semibold text-heading disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onEnd}
          disabled={isBusy}
        >
          Finalizar
        </button>

        {!confirmReset ? (
          <button
            type="button"
            className="min-h-11 cursor-pointer rounded-full px-4 py-2.5 text-sm font-semibold text-danger transition hover:bg-danger-bg active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => setConfirmReset(true)}
            disabled={isBusy}
          >
            Reiniciar
          </button>
        ) : (
          <div
            className="liquid-glass-subtle inline-flex items-center gap-2 rounded-full px-2 py-1"
            role="group"
            aria-label="Confirmar reinicio"
          >
            <button
              type="button"
              className="min-h-9 cursor-pointer rounded-full bg-danger px-3.5 py-1.5 text-xs font-semibold text-danger-ink disabled:cursor-not-allowed disabled:opacity-55"
              onClick={async () => {
                setConfirmReset(false);
                await onReset();
              }}
              disabled={isBusy}
            >
              Confirmar reset
            </button>
            <button
              type="button"
              className="min-h-9 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold text-ink hover:bg-elevated/60 disabled:cursor-not-allowed disabled:opacity-55"
              onClick={() => setConfirmReset(false)}
              disabled={isBusy}
            >
              Cancelar
            </button>
          </div>
        )}
      </div>
    </section>
  );
});
