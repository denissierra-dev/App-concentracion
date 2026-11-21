import { memo, useEffect, useState, type FormEvent } from 'react';
import { previewBreakRules } from '../domain/sessionClock';
import { createSessionInputSchema, SESSION_LIMITS } from '../security/validators';

interface SessionSetupProps {
  defaultFocusMin: number;
  defaultShortBreakMin?: number;
  defaultLongBreakMin?: number;
  defaultCycles: number;
  cyclesBeforeLongBreak: number;
  isSubmitting: boolean;
  onStartSession: (focusDurationMin: number, totalCycles: number) => Promise<void>;
}

const PRESET_MINUTES = [20, 25, 30, 60] as const;

export const SessionSetup = memo(function SessionSetup({
  defaultFocusMin,
  defaultShortBreakMin,
  defaultLongBreakMin,
  defaultCycles,
  cyclesBeforeLongBreak,
  isSubmitting,
  onStartSession,
}: SessionSetupProps) {
  const [focusInput, setFocusInput] = useState<string>(String(defaultFocusMin));
  const [cyclesInput, setCyclesInput] = useState<string>(String(defaultCycles));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setFocusInput(String(defaultFocusMin));
  }, [defaultFocusMin]);

  useEffect(() => {
    setCyclesInput(String(defaultCycles));
  }, [defaultCycles]);

  const parsedFocus = Number(focusInput);
  const previewFocus =
    Number.isInteger(parsedFocus) &&
    parsedFocus >= SESSION_LIMITS.MIN_FOCUS_MIN &&
    parsedFocus <= SESSION_LIMITS.MAX_FOCUS_MIN
      ? parsedFocus
      : defaultFocusMin;

  const breakPreview = previewBreakRules(
    previewFocus,
    cyclesBeforeLongBreak,
    defaultShortBreakMin,
    defaultLongBreakMin
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const parsed = createSessionInputSchema.safeParse({
      focusDurationMin: Number(focusInput),
      totalCycles: Number(cyclesInput),
    });

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? 'Datos de sesión inválidos';
      setValidationError(firstIssue);
      return;
    }

    await onStartSession(parsed.data.focusDurationMin, parsed.data.totalCycles);
  };

  return (
    <section
      className={`liquid-glass liquid-stage-enter rounded-3xl p-6 transition-[opacity,transform] duration-500 ease-out sm:p-8 ${
        isSubmitting ? 'scale-[0.992] opacity-85' : ''
      }`}
      aria-labelledby="setup-heading"
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="setup-heading" className="text-xl font-bold tracking-tight text-heading">
            Nueva sesión de concentración
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Elige tu ritmo de enfoque y comienza sin distracciones
          </p>
        </div>
      </div>

      <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-2.5">
          <span className="text-sm font-semibold text-heading">
            Duración de enfoque (minutos)
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Duraciones rápidas">
            {PRESET_MINUTES.map((min) => {
              const active = Number(focusInput) === min;
              return (
                <button
                  key={min}
                  type="button"
                  className={`min-h-11 cursor-pointer rounded-2xl border px-3 py-2 text-sm font-semibold transition active:scale-[0.98] ${
                    active
                      ? 'border-brand bg-brand text-brand-ink shadow-sm'
                      : 'liquid-glass-subtle text-heading hover:border-brand'
                  }`}
                  onClick={() => {
                    setFocusInput(String(min));
                    setValidationError(null);
                  }}
                >
                  {min} min
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label htmlFor="custom-focus-min" className="sr-only">
              Duración personalizada en minutos
            </label>
            <input
              id="custom-focus-min"
              type="number"
              inputMode="numeric"
              min={SESSION_LIMITS.MIN_FOCUS_MIN}
              max={SESSION_LIMITS.MAX_FOCUS_MIN}
              step={1}
              value={focusInput}
              onChange={(e) => {
                setFocusInput(e.target.value);
                setValidationError(null);
              }}
              className="liquid-glass-subtle w-36 rounded-xl px-3.5 py-2.5 text-sm font-medium text-heading"
              placeholder="Ej. 45"
            />
            <span className="text-xs text-muted">
              Rango permitido: {SESSION_LIMITS.MIN_FOCUS_MIN}–{SESSION_LIMITS.MAX_FOCUS_MIN} min
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="total-cycles-input" className="text-sm font-semibold text-heading">
            Ciclos totales ({SESSION_LIMITS.MIN_CYCLES}–{SESSION_LIMITS.MAX_CYCLES})
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Disminuir ciclos"
              className="liquid-pill flex h-11 w-11 cursor-pointer items-center justify-center rounded-2xl text-base font-bold text-heading disabled:cursor-not-allowed disabled:opacity-45"
              disabled={Number(cyclesInput) <= SESSION_LIMITS.MIN_CYCLES}
              onClick={() => {
                const current = Number.isInteger(Number(cyclesInput))
                  ? Number(cyclesInput)
                  : defaultCycles;
                const next = Math.max(SESSION_LIMITS.MIN_CYCLES, current - 1);
                setCyclesInput(String(next));
                setValidationError(null);
              }}
            >
              −
            </button>
            <input
              id="total-cycles-input"
              type="number"
              inputMode="numeric"
              min={SESSION_LIMITS.MIN_CYCLES}
              max={SESSION_LIMITS.MAX_CYCLES}
              step={1}
              value={cyclesInput}
              onChange={(e) => {
                setCyclesInput(e.target.value);
                setValidationError(null);
              }}
              className="liquid-glass-subtle h-11 w-24 rounded-xl px-3 py-2 text-center text-sm font-semibold text-heading"
            />
            <button
              type="button"
              aria-label="Aumentar ciclos"
              className="liquid-pill flex h-11 w-11 cursor-pointer items-center justify-center rounded-2xl text-base font-bold text-heading disabled:cursor-not-allowed disabled:opacity-45"
              disabled={Number(cyclesInput) >= SESSION_LIMITS.MAX_CYCLES}
              onClick={() => {
                const current = Number.isInteger(Number(cyclesInput))
                  ? Number(cyclesInput)
                  : defaultCycles;
                const next = Math.min(SESSION_LIMITS.MAX_CYCLES, current + 1);
                setCyclesInput(String(next));
                setValidationError(null);
              }}
            >
              +
            </button>
          </div>
        </div>

        <div className="liquid-glass-subtle rounded-2xl p-4" aria-live="polite">
          <p className="mb-1.5 text-xs font-semibold text-heading">Resumen de descansos:</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            <li>
              Descanso corto: <strong className="text-ink">{breakPreview.shortBreakMin} min</strong>{' '}
              {breakPreview.isCustomShortBreak
                ? '(preferencia personalizada)'
                : previewFocus > SESSION_LIMITS.EXTENDED_FOCUS_THRESHOLD_MIN
                  ? '(enfoque > 40 min)'
                  : '(enfoque ≤ 40 min)'}
            </li>
            <li>
              Descanso largo: <strong className="text-ink">{breakPreview.longBreakMin} min</strong>{' '}
              cada {breakPreview.cyclesBeforeLongBreak} ciclos
            </li>
          </ul>
        </div>

        {validationError && (
          <p
            className="rounded-2xl border border-danger bg-danger-bg px-4 py-2.5 text-sm font-medium text-danger"
            role="alert"
          >
            {validationError}
          </p>
        )}

        <button
          type="submit"
          className="min-h-12 cursor-pointer rounded-full bg-accent px-6 py-3 text-base font-bold text-accent-ink shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Iniciando...' : 'Iniciar sesión'}
        </button>
      </form>
    </section>
  );
});
