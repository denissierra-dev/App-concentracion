import { useEffect, useRef, useState } from 'react';
import { APP_THEMES, getThemeOption } from '../domain/themes';
import type { AppTheme } from '../domain/types';

interface HeaderBarProps {
  serverOnline: boolean;
  clockOffsetMs: number;
  pendingSyncCount: number;
  deviceId: string | null;
  theme: AppTheme;
  onSelectTheme: (theme: AppTheme) => void;
  onOpenIdentity: () => void;
  onOpenPreferences: () => void;
  onRefreshSync: () => void;
}

export function HeaderBar({
  serverOnline,
  clockOffsetMs,
  pendingSyncCount,
  deviceId,
  theme,
  onSelectTheme,
  onOpenIdentity,
  onOpenPreferences,
  onRefreshSync,
}: HeaderBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const shortDevice = deviceId ? `${deviceId.slice(0, 8)}...` : 'Sin registrar';
  const currentTheme = getThemeOption(theme);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-edge bg-surface px-6 py-4">
      <div className="flex items-center gap-3">
        <span
          className="h-3.5 w-3.5 rounded-full bg-accent ring-4 ring-accent/25"
          aria-hidden="true"
        />
        <div>
          <h1 className="text-lg font-bold leading-tight text-heading">Deep-Work</h1>
          <p className="text-xs text-muted">Arquitectura Back-end First</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-ink transition hover:border-brand"
          onClick={onRefreshSync}
          title="Sincronizar reloj y estado con el servidor"
        >
          <span
            className={`h-2 w-2 rounded-full ${serverOnline ? 'bg-success' : 'bg-danger'}`}
            aria-hidden="true"
          />
          <span>{serverOnline ? 'Servidor en línea' : 'Sin conexión'}</span>
          {pendingSyncCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">
              {pendingSyncCount} pend.
            </span>
          )}
          {serverOnline && (
            <span className="font-mono text-[11px] text-muted">
              {clockOffsetMs >= 0 ? `+${clockOffsetMs}ms` : `${clockOffsetMs}ms`}
            </span>
          )}
        </button>

        <button
          type="button"
          className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-elevated"
          onClick={onOpenIdentity}
          title="Ver o recuperar UUID de dispositivo"
        >
          Dispositivo: <code className="font-mono">{shortDevice}</code>
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-semibold text-heading transition hover:border-brand"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Seleccionar tema (${currentTheme.label})`}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <span
              className={`inline-block h-3 w-3 shrink-0 rounded-full ${currentTheme.swatchClass}`}
              aria-hidden="true"
            />
            <span>{currentTheme.headerLabel}</span>
            <span className="text-[10px] text-muted" aria-hidden="true">
              ▾
            </span>
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="Paletas de temas"
              className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-edge bg-surface p-1.5 shadow-xl"
            >
              {APP_THEMES.map((option) => {
                const isSelected = option.id === theme;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                      isSelected
                        ? 'bg-brand font-semibold text-brand-ink'
                        : 'text-ink hover:bg-elevated'
                    }`}
                    onClick={() => {
                      onSelectTheme(option.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 shrink-0 rounded-full ${option.swatchClass}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{option.label}</span>
                      <span
                        className={`block truncate text-[10px] ${
                          isSelected ? 'opacity-85' : 'text-muted'
                        }`}
                      >
                        {option.description}
                      </span>
                    </span>
                    {isSelected && (
                      <span className="text-[11px] font-bold" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          className="cursor-pointer rounded-lg border border-edge bg-elevated px-3 py-1.5 text-xs font-semibold text-heading transition hover:border-brand"
          onClick={onOpenPreferences}
        >
          Preferencias
        </button>
      </div>
    </header>
  );
}
