import { memo } from 'react';
import { getPhaseLabel } from '../domain/sessionClock';
import type { SessionPlanPhase } from '../domain/types';

interface PhaseTimelineProps {
  plan: SessionPlanPhase[];
  effectiveIndex: number;
}

export const PhaseTimeline = memo(function PhaseTimeline({
  plan,
  effectiveIndex,
}: PhaseTimelineProps) {
  return (
    <section aria-label="Secuencia de bloques">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          Secuencia de bloques ({plan.length} fases)
        </span>
      </div>

      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {plan.map((phase) => {
          const isCurrent = phase.index === effectiveIndex;
          const isDone = phase.index < effectiveIndex;
          const minutes = Math.round(phase.durationMs / 60_000);

          return (
            <li
              key={phase.index}
              className={`liquid-glass-subtle flex items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-xs transition ${
                isCurrent ? 'border-accent font-bold ring-2 ring-accent/35' : ''
              } ${isDone ? 'opacity-50' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="font-bold text-brand">C{phase.cycleNumber}</span>
              <span className="text-ink">{getPhaseLabel(phase.phaseType)}</span>
              <span className="font-mono text-muted">{minutes} min</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
});
