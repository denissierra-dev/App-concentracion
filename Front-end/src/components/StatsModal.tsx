import { useMemo, useRef, useState } from 'react';
import type { StatsDashboardResponse, StatsExportFormat } from '../domain/types';
import { useModalEscape } from '../hooks/useModalEscape';

interface StatsModalProps {
  stats: StatsDashboardResponse | null;
  days: number;
  isLoading: boolean;
  isExporting: boolean;
  error: string | null;
  onChangeDays: (days: number) => void;
  onRefresh: () => void;
  onExport: (format: StatsExportFormat) => void;
  onClose: () => void;
}

const DAY_WINDOW_OPTIONS = [
  { value: 7, label: 'Últimos 7 días' },
  { value: 14, label: 'Últimos 14 días' },
  { value: 30, label: 'Últimos 30 días' },
  { value: 90, label: 'Últimos 90 días' },
  { value: 365, label: 'Último año (365 días)' },
] as const;

const WEEKDAY_ES: Record<number, string> = {
  0: 'Dom',
  1: 'Lun',
  2: 'Mar',
  3: 'Mié',
  4: 'Jue',
  5: 'Vie',
  6: 'Sáb',
};

function formatMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function formatHourUtc(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

export function StatsModal({
  stats,
  days,
  isLoading,
  isExporting,
  error,
  onChangeDays,
  onRefresh,
  onExport,
  onClose,
}: StatsModalProps) {
  const [onlyActiveDays, setOnlyActiveDays] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalEscape(dialogRef, onClose);

  const maxWeekdayFocusMs = useMemo(() => {
    if (!stats) return 1;
    return Math.max(1, ...stats.productivity.byWeekday.map((p) => p.focusMs));
  }, [stats]);

  const maxHourlyFocusMs = useMemo(() => {
    if (!stats) return 1;
    return Math.max(1, ...stats.productivity.byHour.map((p) => p.focusMs));
  }, [stats]);

  const visibleDays = useMemo(() => {
    if (!stats) return [];
    const reversed = [...stats.productivity.byDay].reverse();
    if (!onlyActiveDays) {
      return reversed;
    }
    return reversed.filter(
      (d) =>
        d.sessionsCompleted > 0 ||
        d.focusMs > 0 ||
        d.tasksCompleted > 0 ||
        d.primordialCompleted > 0 ||
        d.primordialIgnored > 0
    );
  }, [stats, onlyActiveDays]);

  const completionPercent =
    stats && stats.primordial.completionRate !== null
      ? `${Math.round(stats.primordial.completionRate * 100)}%`
      : 'Sin historial';

  return (
    <div
      ref={dialogRef}
      className="liquid-backdrop fixed inset-0 z-50 flex items-end justify-center p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stats-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="liquid-glass-strong liquid-modal-panel max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl sm:p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="stats-title" className="text-lg font-bold text-heading">
              Estadísticas de productividad
            </h2>
            <p className="text-xs text-muted">
              Resumen de enfoque, rachas y tareas completadas (UTC)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Ventana de días"
              value={days}
              disabled={isLoading || isExporting}
              onChange={(e) => {
                const nextDays = Number(e.target.value);
                if (Number.isInteger(nextDays) && nextDays >= 1 && nextDays <= 365) {
                  onChangeDays(nextDays);
                }
              }}
              className="liquid-glass-subtle min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
            >
              {DAY_WINDOW_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="liquid-pill min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading disabled:opacity-55"
              onClick={onRefresh}
              disabled={isLoading || isExporting}
            >
              {isLoading ? 'Cargando...' : 'Actualizar'}
            </button>

            <button
              type="button"
              className="min-h-9 cursor-pointer rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-ink transition hover:bg-brand-hover disabled:opacity-55"
              onClick={() => onExport('json')}
              disabled={isLoading || isExporting}
            >
              {isExporting ? 'Exportando...' : 'Exportar JSON'}
            </button>

            <button
              type="button"
              className="min-h-9 cursor-pointer rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-accent-ink transition hover:bg-accent-hover disabled:opacity-55"
              onClick={() => onExport('csv')}
              disabled={isLoading || isExporting}
            >
              Exportar CSV
            </button>

            <button
              type="button"
              className="liquid-pill min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-ink"
              onClick={onClose}
            >
              Cerrar
            </button>
          </div>
        </div>

        {error && (
          <p
            className="mb-4 rounded-xl border border-danger bg-danger-bg px-3.5 py-2.5 text-xs font-medium text-danger"
            role="alert"
          >
            {error}
          </p>
        )}

        {isLoading && !stats ? (
          <div
            className="rounded-xl border border-edge bg-canvas px-4 py-12 text-center text-sm text-muted"
            aria-busy="true"
          >
            Calculando métricas de productividad...
          </div>
        ) : stats ? (
          <div className="flex flex-col gap-5">
            {/* Summary KPI Cards */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="liquid-glass-subtle rounded-2xl p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Hoy ({stats.today.date} UTC)
                </p>
                <p className="mt-1 text-2xl font-extrabold text-heading">
                  {Math.round(stats.today.focusMinutes)} min
                </p>
                <p className="mt-1 text-xs text-ink">
                  {stats.today.sessionsCompleted} sesiones · {stats.today.tasksCompleted} tareas
                </p>
              </div>

              <div className="liquid-glass-subtle rounded-2xl p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Totales acumulados
                </p>
                <p className="mt-1 text-2xl font-extrabold text-heading">
                  {Math.round(stats.totals.focusMinutes)} min
                </p>
                <p className="mt-1 text-xs text-ink">
                  {stats.totals.sessionsCompleted} sesiones · {stats.totals.cyclesCompleted} ciclos
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  Tareas: {stats.totals.tasksCompleted} comp. / {stats.totals.tasksPending} pend.
                </p>
              </div>

              <div className="liquid-glass-subtle rounded-2xl p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Rachas de actividad
                </p>
                <p className="mt-1 text-2xl font-extrabold text-brand">
                  {stats.streaks.currentDays} días
                </p>
                <p className="mt-1 text-xs text-ink">
                  Mejor racha: <strong>{stats.streaks.longestDays} días</strong>
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  Último día: {stats.streaks.lastActiveDate ?? 'Sin actividad'}
                </p>
              </div>

              <div className="liquid-glass-subtle rounded-2xl p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Cumplimiento primordial
                </p>
                <p className="mt-1 text-2xl font-extrabold text-heading">{completionPercent}</p>
                <p className="mt-1 text-xs text-ink">
                  {stats.primordial.completedBeforeDeadline} a tiempo · {stats.primordial.ignored}{' '}
                  ignoradas
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {stats.primordial.activePending} prioritarias activas
                </p>
              </div>
            </div>

            {/* Hourly & Weekday Breakdown */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <section
                className="liquid-glass-subtle rounded-2xl p-4"
                aria-labelledby="stats-hourly-heading"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 id="stats-hourly-heading" className="text-sm font-bold text-heading">
                    Actividad por hora (UTC)
                  </h3>
                  {stats.productivity.peakHour ? (
                    <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-accent-ink">
                      Pico: {formatHourUtc(stats.productivity.peakHour.hour)} (
                      {formatMinutes(stats.productivity.peakHour.focusMs)} min)
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Sin hora pico aún</span>
                  )}
                </div>

                <svg
                  viewBox="0 0 288 76"
                  className="h-24 w-full"
                  role="img"
                  aria-label="Gráfica de enfoque por hora UTC"
                >
                  {stats.productivity.byHour.map((point) => {
                    const barHeight =
                      point.focusMs > 0
                        ? Math.max(4, Math.round((point.focusMs / maxHourlyFocusMs) * 52))
                        : 2;
                    const isPeak = stats.productivity.peakHour?.hour === point.hour;
                    const barFill = isPeak
                      ? 'fill-accent'
                      : point.focusMs > 0
                        ? 'fill-brand'
                        : 'fill-elevated';

                    return (
                      <g key={point.hour}>
                        <rect
                          x={point.hour * 12 + 2}
                          y={56 - barHeight}
                          width={8}
                          height={barHeight}
                          rx={2}
                          className={barFill}
                        >
                          <title>
                            {`${formatHourUtc(point.hour)}: ${formatMinutes(point.focusMs)} min, ${point.focusCycles} ciclos, ${point.tasksCompleted} tareas`}
                          </title>
                        </rect>
                        {point.hour % 6 === 0 && (
                          <text
                            x={point.hour * 12 + 6}
                            y={70}
                            textAnchor="middle"
                            className="fill-muted text-[8px] font-mono"
                          >
                            {String(point.hour).padStart(2, '0')}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </section>

              <section
                className="liquid-glass-subtle rounded-2xl p-4"
                aria-labelledby="stats-weekday-heading"
              >
                <h3 id="stats-weekday-heading" className="mb-3 text-sm font-bold text-heading">
                  Por día de la semana ({stats.productivity.windowDays} días)
                </h3>

                <div className="flex flex-col gap-2">
                  {stats.productivity.byWeekday.map((point) => {
                    const barWidth =
                      point.focusMs > 0
                        ? Math.max(6, Math.round((point.focusMs / maxWeekdayFocusMs) * 140))
                        : 0;
                    const label = WEEKDAY_ES[point.weekday] ?? point.label;

                    return (
                      <div key={point.weekday} className="flex items-center gap-2.5 text-xs">
                        <span className="w-8 font-semibold text-heading">{label}</span>
                        <svg
                          viewBox="0 0 140 10"
                          className="h-2.5 flex-1"
                          aria-hidden="true"
                        >
                          <rect x={0} y={1} width={140} height={8} rx={4} className="fill-elevated" />
                          {barWidth > 0 && (
                            <rect
                              x={0}
                              y={1}
                              width={barWidth}
                              height={8}
                              rx={4}
                              className="fill-brand"
                            />
                          )}
                        </svg>
                        <span className="w-28 text-right font-mono text-[11px] text-muted">
                          {formatMinutes(point.focusMs)}m · {point.tasksCompleted} tar.
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* Daily History Table */}
            <section
              className="liquid-glass-subtle rounded-2xl p-4"
              aria-labelledby="stats-daily-heading"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 id="stats-daily-heading" className="text-sm font-bold text-heading">
                  Desglose diario (ventana de {stats.productivity.windowDays} días)
                </h3>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={onlyActiveDays}
                    onChange={(e) => setOnlyActiveDays(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span>Solo días con actividad</span>
                </label>
              </div>

              {visibleDays.length === 0 ? (
                <p className="rounded-lg border border-dashed border-edge px-3 py-5 text-center text-xs text-muted">
                  No hay actividad registrada en esta ventana de días.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-edge text-[11px] text-muted">
                        <th className="py-1.5 pr-3 font-semibold">Fecha (UTC)</th>
                        <th className="py-1.5 pr-3 font-semibold">Sesiones</th>
                        <th className="py-1.5 pr-3 font-semibold">Enfoque</th>
                        <th className="py-1.5 pr-3 font-semibold">Tareas</th>
                        <th className="py-1.5 font-semibold">Primordiales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleDays.map((day) => (
                        <tr key={day.date} className="border-b border-edge/60 last:border-b-0">
                          <td className="py-1.5 pr-3 font-mono text-heading">{day.date}</td>
                          <td className="py-1.5 pr-3 text-ink">{day.sessionsCompleted}</td>
                          <td className="py-1.5 pr-3 font-semibold text-heading">
                            {Math.round(day.focusMinutes)} min
                          </td>
                          <td className="py-1.5 pr-3 text-ink">{day.tasksCompleted}</td>
                          <td className="py-1.5 text-muted">
                            +{day.primordialCompleted} / -{day.primordialIgnored}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
