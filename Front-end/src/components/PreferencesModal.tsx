import { useState, type FormEvent } from 'react';
import { previewBreakRules } from '../domain/sessionClock';
import { APP_THEMES, isAppTheme, toBackendTheme } from '../domain/themes';
import type { AppTheme, Preference, ThemePreference } from '../domain/types';
import { SESSION_LIMITS, updatePreferencesInputSchema } from '../security/validators';

interface PreferencesModalProps {
  preferences: Preference;
  currentTheme?: AppTheme;
  isSaving: boolean;
  onClose: () => void;
  onSelectTheme?: (theme: AppTheme) => void;
  onSave: (patch: {
    focusDurationMin: number;
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
  onSave,
  onRequestNotificationPermission,
}: PreferencesModalProps) {
  const [focusDurationMin, setFocusDurationMin] = useState(String(preferences.focusDurationMin));
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

  const parsedFocus = Number(focusDurationMin);
  const previewFocus =
    Number.isInteger(parsedFocus) &&
    parsedFocus >= SESSION_LIMITS.MIN_FOCUS_MIN &&
    parsedFocus <= SESSION_LIMITS.MAX_FOCUS_MIN
      ? parsedFocus
      : preferences.focusDurationMin;
  const parsedCycles = Number(cyclesBeforeLongBreak);
  const previewCycles =
    Number.isInteger(parsedCycles) &&
    parsedCycles >= SESSION_LIMITS.MIN_CYCLES &&
    parsedCycles <= SESSION_LIMITS.MAX_CYCLES
      ? parsedCycles
      : preferences.cyclesBeforeLongBreak;

  const breakRules = previewBreakRules(previewFocus, previewCycles);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const backendTheme = toBackendTheme(theme);

    const parsed = updatePreferencesInputSchema.safeParse({
      focusDurationMin: Number(focusDurationMin),
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-edge bg-surface p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 id="prefs-title" className="text-lg font-bold text-heading">
            Preferencias autoritativas
          </h2>
          <button
            type="button"
            className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold text-ink hover:bg-elevated"
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
          </div>

          <div className="rounded-xl border border-edge bg-canvas px-3.5 py-2.5 text-xs text-muted">
            Descansos calculados por el servidor:{' '}
            <strong className="text-heading">{breakRules.shortBreakMin} min</strong> corto ·{' '}
            <strong className="text-heading">{breakRules.longBreakMin} min</strong> largo cada{' '}
            {breakRules.cyclesBeforeLongBreak} ciclos.
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

          <div className="mt-2 flex justify-end gap-2.5">
            <button
              type="button"
              className="cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold text-ink hover:bg-elevated disabled:opacity-55"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="cursor-pointer rounded-xl bg-accent px-4 py-2 text-sm font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-55"
              disabled={isSaving}
            >
              {isSaving ? 'Guardando...' : 'Guardar en servidor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
