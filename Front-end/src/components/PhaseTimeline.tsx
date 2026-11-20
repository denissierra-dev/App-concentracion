import { getPhaseLabel } from '../domain/sessionClock';
import type { SessionPlanPhase } from '../domain/types';

interface PhaseTimelineProps {
  plan: SessionPlanPhase[];
  effectiveIndex: number;
}

export function PhaseTimeline({ plan, effectiveIndex }: PhaseTimelineProps) {
  return (
    <section
      className="rounded-2xl border border-edge bg-surface p-6 shadow-sm"
      aria-labelledby="timeline-heading"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline-heading" className="text-base font-bold text-heading">
          Plan de la sesión
        </h2>
        <span className="text-xs text-muted">Avance local sin peticiones por fase</span>
      </div>

      <ol className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        {plan.map((phase) => {
          const isCurrent = phase.index === effectiveIndex;
          const isDone = phase.index < effectiveIndex;
          const minutes = Math.round(phase.durationMs / 60_000);

          return (
            <li
              key={phase.index}
              className={`flex items-center justify-between gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                isCurrent
                  ? 'border-accent bg-canvas font-bold ring-2 ring-accent/30'
                  : 'border-edge bg-canvas'
              } ${isDone ? 'opacity-50' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="font-bold text-brand">C{phase.cycleNumber}</span>
              <span className="text-ink">{getPhaseLabel(phase.phaseType)}</span>
              <span className="text-muted">{minutes} min</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
