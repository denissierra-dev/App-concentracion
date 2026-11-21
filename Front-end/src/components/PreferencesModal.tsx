import { useRef, useState, type FormEvent } from 'react';
import { previewBreakRules } from '../domain/sessionClock';
import { APP_THEMES, isAppTheme, toBackendTheme } from '../domain/themes';
import type { AppTheme, Preference, ThemePreference } from '../domain/types';
import { useModalEscape } from '../hooks/useModalEscape';
import { SESSION_LIMITS, updatePreferencesInputSchema } from '../security/validators';

interface PreferencesModalProps {
  preferences: Preference;
  currentTheme?: AppTheme;
  isSaving: boolean;
  onClose: () => void;
  onSelectTheme?: (theme: AppTheme) => void;
  onOpenIdentity?: () => void;
  onSave: (patch: {
    focusDurationMin: number;
    shortBreakMin: number;
    longBreakMin: number;
    cyclesBeforeLongBreak: number;
    volumeFocus: number;
    volumeBreak: number;
    notificationsEnabled: boolean;
    theme: ThemePreference;
  }) => Promise<void>;
  onRequestNotificationPermission: () => Promise<NotificationPermission | 'unsupported'>;
}

export function PreferencesModal({
  preferences,
  currentTheme,
  isSaving,
  onClose,
  onSelectTheme,
  onOpenIdentity,
  onSave,
  onRequestNotificationPermission,
}: PreferencesModalProps) {
  const [focusDurationMin, setFocusDurationMin] = useState(String(preferences.focusDurationMin));
  const [shortBreakMin, setShortBreakMin] = useState(String(preferences.shortBreakMin));
  const [longBreakMin, setLongBreakMin] = useState(String(preferences.longBreakMin));
  const [cyclesBeforeLongBreak, setCyclesBeforeLongBreak] = useState(
    String(preferences.cyclesBeforeLongBreak)
  );
  const [volumeFocus, setVolumeFocus] = useState(preferences.volumeFocus);
  const [volumeBreak, setVolumeBreak] = useState(preferences.volumeBreak);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    preferences.notificationsEnabled
  );
  const [theme, setTheme] = useState<AppTheme>(currentTheme ?? preferences.theme);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalEscape(dialogRef, onClose, isSaving);

  const parsedFocus = Number(focusDurationMin);
  const previewFocus =
    Number.isInteger(parsedFocus) &&
    parsedFocus >= SESSION_LIMITS.MIN_FOCUS_MIN &&
    parsedFocus <= SESSION_LIMITS.MAX_FOCUS_MIN
      ? parsedFocus
      : preferences.focusDurationMin;

  const parsedShortBreak = Number(shortBreakMin);
  const previewShortBreak =
    Number.isInteger(parsedShortBreak) && parsedShortBreak >= 1 && parsedShortBreak <= 60
      ? parsedShortBreak
      : preferences.shortBreakMin;

  const parsedLongBreak = Number(longBreakMin);
  const previewLongBreak =
    Number.isInteger(parsedLongBreak) &&
    parsedLongBreak >= SESSION_LIMITS.MIN_LONG_BREAK_MIN &&
    parsedLongBreak <= SESSION_LIMITS.MAX_LONG_BREAK_MIN
      ? parsedLongBreak
      : preferences.longBreakMin;

  const parsedCycles = Number(cyclesBeforeLongBreak);
  const previewCycles =
    Number.isInteger(parsedCycles) &&
    parsedCycles >= SESSION_LIMITS.MIN_CYCLES &&
    parsedCycles <= SESSION_LIMITS.MAX_CYCLES
      ? parsedCycles
      : preferences.cyclesBeforeLongBreak;

  const breakRules = previewBreakRules(
    previewFocus,
    previewCycles,
    previewShortBreak,
    previewLongBreak
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const backendTheme = toBackendTheme(theme);

    const parsed = updatePreferencesInputSchema.safeParse({
      focusDurationMin: Number(focusDurationMin),
      shortBreakMin: Number(shortBreakMin),
      longBreakMin: Number(longBreakMin),
      cyclesBeforeLongBreak: Number(cyclesBeforeLongBreak),
      volumeFocus: Number(volumeFocus),
      volumeBreak: Number(volumeBreak),
      notificationsEnabled,
      theme: backendTheme,
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Preferencias inválidas');
      return;
    }

    if (notificationsEnabled) {
      await onRequestNotificationPermission();
    }

    onSelectTheme?.(theme);

    await onSave({
      focusDurationMin: parsed.data.focusDurationMin ?? preferences.focusDurationMin,
      shortBreakMin: parsed.data.shortBreakMin ?? preferences.shortBreakMin,
      longBreakMin: parsed.data.longBreakMin ?? preferences.longBreakMin,
      cyclesBeforeLongBreak:
        parsed.data.cyclesBeforeLongBreak ?? preferences.cyclesBeforeLongBreak,
      volumeFocus: parsed.data.volumeFocus ?? preferences.volumeFocus,
      volumeBreak: parsed.data.volumeBreak ?? preferences.volumeBreak,
      notificationsEnabled: parsed.data.notificationsEnabled ?? preferences.notificationsEnabled,
      theme: parsed.data.theme ?? preferences.theme,
    });
  };

  return (
    <div
      ref={dialogRef}
      className="liquid-backdrop fixed inset-0 z-50 flex items-end justify-center p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) {
          onClose();
        }
      }}
    >
      <div className="liquid-glass-strong liquid-modal-panel max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 id="prefs-title" className="text-lg font-bold text-heading">
            Preferencias
          </h2>
          <button
            type="button"
            className="liquid-pill min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pref-focus" className="text-xs font-semibold text-heading">
                Enfoque predeterminado (min)
              </label>
              <input
                id="pref-focus"
                type="number"
                min={SESSION_LIMITS.MIN_FOCUS_MIN}
                max={SESSION_LIMITS.MAX_FOCUS_MIN}
                value={focusDurationMin}
                onChange={(e) => setFocusDurationMin(e.target.value)}
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pref-cycles" className="text-xs font-semibold text-heading">
                Ciclos antes de descanso largo
              </label>
              <input
                id="pref-cycles"
                type="number"
                min={SESSION_LIMITS.MIN_CYCLES}
                max={SESSION_LIMITS.MAX_CYCLES}
                value={cyclesBeforeLongBreak}
                onChange={(e) => setCyclesBeforeLongBreak(e.target.value)}
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pref-short-break" className="text-xs font-semibold text-heading">
                Descanso corto base (min)
              </label>
              <input
                id="pref-short-break"
                type="number"
                min={1}
                max={60}
                value={shortBreakMin}
                onChange={(e) => setShortBreakMin(e.target.value)}
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pref-long-break" className="text-xs font-semibold text-heading">
                Descanso largo (min)
              </label>
              <input
                id="pref-long-break"
                type="number"
                min={SESSION_LIMITS.MIN_LONG_BREAK_MIN}
                max={SESSION_LIMITS.MAX_LONG_BREAK_MIN}
                value={longBreakMin}
                onChange={(e) => setLongBreakMin(e.target.value)}
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
              />
            </div>
          </div>

          <div className="rounded-xl border border-edge bg-canvas px-3.5 py-2.5 text-xs text-muted">
            Vista previa:{' '}
            <strong className="text-heading">{breakRules.shortBreakMin} min</strong> corto ·{' '}
            <strong className="text-heading">{breakRules.longBreakMin} min</strong> largo cada{' '}
            {breakRules.cyclesBeforeLongBreak} ciclos.
            {previewLongBreak < 2 * previewShortBreak && (
              <span className="mt-1 block text-[11px]">
                El descanso largo se ajusta automáticamente a mínimo 2× el descanso corto.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="pref-vol-focus" className="font-semibold text-heading">
                Volumen en fase de enfoque
              </label>
              <span className="font-mono text-muted">{Math.round(volumeFocus * 100)}%</span>
            </div>
            <input
              id="pref-vol-focus"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volumeFocus}
              onChange={(e) => setVolumeFocus(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="pref-vol-break" className="font-semibold text-heading">
                Volumen en fase de descanso
              </label>
              <span className="font-mono text-muted">{Math.round(volumeBreak * 100)}%</span>
            </div>
            <input
              id="pref-vol-break"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volumeBreak}
              onChange={(e) => setVolumeBreak(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="pref-theme" className="text-xs font-semibold text-heading">
              Tema visual
            </label>
            <select
              id="pref-theme"
              value={theme}
              onChange={(e) => {
                const val = e.target.value;
                if (isAppTheme(val)) {
                  setTheme(val);
                }
              }}
              className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
            >
              {APP_THEMES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>

            <div
              className="grid grid-cols-2 gap-1.5 pt-1 sm:grid-cols-4"
              role="group"
              aria-label="Paletas rápidas"
            >
              {APP_THEMES.map((option) => {
                const selected = option.id === theme;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTheme(option.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs font-semibold transition ${
                      selected
                        ? 'border-brand bg-brand text-brand-ink'
                        : 'border-edge bg-canvas text-ink hover:border-brand'
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 shrink-0 rounded-full ${option.swatchClass}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(e) => setNotificationsEnabled(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            <span>Activar notificaciones locales en transiciones de fase</span>
          </label>

          {error && (
            <p
              className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2.5">
            {onOpenIdentity ? (
              <button
                type="button"
                className="liquid-pill min-h-10 cursor-pointer rounded-full px-3.5 py-2 text-xs font-semibold text-ink"
                onClick={() => {
                  onClose();
                  onOpenIdentity();
                }}
                disabled={isSaving}
              >
                Cuenta y sesiones
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2.5">
              <button
                type="button"
                className="liquid-pill min-h-10 cursor-pointer rounded-full px-4 py-2 text-sm font-semibold text-ink disabled:opacity-55"
                onClick={onClose}
                disabled={isSaving}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="min-h-10 cursor-pointer rounded-full bg-accent px-5 py-2 text-sm font-bold text-accent-ink transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-55"
                disabled={isSaving}
              >
                {isSaving ? 'Guardando...' : 'Guardar preferencias'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
