import { useState } from 'react';
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
  onSyncState: () => Promise<void>;
}

const RING_RADIUS = 108;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function TimerDisplay({
  session,
  snapshot,
  isBusy,
  onPause,
  onResume,
  onSkip,
  onEnd,
  onReset,
  onSyncState,
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
      className="rounded-2xl border border-edge bg-surface p-6 shadow-sm"
      aria-label="Cronómetro de concentración"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${phaseBadgeClass}`}
          >
            {phase ? getPhaseLabel(phase.phaseType) : 'Sesión finalizada'}
          </span>
          {phase && (
            <span className="inline-flex items-center rounded-full bg-elevated px-3 py-1 text-xs font-semibold text-ink">
              Ciclo {phase.cycleNumber} / {totalCycles}
            </span>
          )}
          {session.status === 'paused' && (
            <span className="inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-ink">
              En pausa
            </span>
          )}
        </div>

        <button
          type="button"
          className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold text-ink transition hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onSyncState}
          disabled={isBusy}
          title="Re-sincronizar estado autoritativo con el servidor"
        >
          v{session.version} · Reconciliar
        </button>
      </div>

      <div className="relative mx-auto my-6 h-60 w-60">
        <svg
          className="h-full w-full -rotate-90"
          viewBox="0 0 240 240"
          role="img"
          aria-label={`Tiempo restante ${formatDurationMs(snapshot.remainingMs)}`}
        >
          <circle
            className="fill-none stroke-elevated stroke-[12]"
            cx="120"
            cy="120"
            r={RING_RADIUS}
          />
          <circle
            className={`fill-none stroke-[12] transition-[stroke-dashoffset] duration-200 ease-linear ${ringStrokeClass}`}
            cx="120"
            cy="120"
            r={RING_RADIUS}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-5xl font-extrabold tracking-tight tabular-nums text-heading">
            {formatDurationMs(snapshot.remainingMs)}
          </span>
          <span className="mt-1 text-xs text-muted">
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
            className="cursor-pointer rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onPause}
            disabled={isBusy}
          >
            Pausar
          </button>
        )}

        {session.status === 'paused' && (
          <button
            type="button"
            className="cursor-pointer rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-accent-ink transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onResume}
            disabled={isBusy}
          >
            Reanudar
          </button>
        )}

        {!snapshot.isPlanCompleted && (
          <button
            type="button"
            className="cursor-pointer rounded-xl border border-edge bg-elevated px-4 py-2.5 text-sm font-semibold text-heading transition hover:border-brand disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onSkip}
            disabled={isBusy}
          >
            Saltar fase
          </button>
        )}

        <button
          type="button"
          className="cursor-pointer rounded-xl border border-edge bg-elevated px-4 py-2.5 text-sm font-semibold text-heading transition hover:border-brand disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onEnd}
          disabled={isBusy}
        >
          Finalizar
        </button>

        {!confirmReset ? (
          <button
            type="button"
            className="cursor-pointer rounded-xl px-4 py-2.5 text-sm font-semibold text-danger transition hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => setConfirmReset(true)}
            disabled={isBusy}
          >
            Reiniciar
          </button>
        ) : (
          <div className="inline-flex items-center gap-2" role="group" aria-label="Confirmar reinicio">
            <button
              type="button"
              className="cursor-pointer rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-danger-ink disabled:cursor-not-allowed disabled:opacity-55"
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
              className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold text-ink hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-55"
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
}
