import { memo, useEffect, useRef, useState } from 'react';
import { APP_THEMES, getThemeOption } from '../domain/themes';
import type { AppTheme, PublicUser } from '../domain/types';

interface HeaderBarProps {
  serverOnline: boolean;
  clockOffsetMs?: number;
  pendingSyncCount?: number;
  deviceId?: string | null;
  user?: PublicUser | null;
  theme: AppTheme;
  isAudioPlaying?: boolean;
  hasActiveSession?: boolean;
  onSelectTheme: (theme: AppTheme) => void;
  onOpenAudio?: () => void;
  onOpenTimeline?: () => void;
  onOpenSearch?: () => void;
  onOpenStats?: () => void;
  onOpenAccount?: () => void;
  onOpenIdentity?: () => void;
  onOpenPreferences: () => void;
  onRefreshSync?: () => void;
}

export const HeaderBar = memo(function HeaderBar({
  serverOnline,
  user = null,
  theme,
  isAudioPlaying = false,
  hasActiveSession = false,
  onSelectTheme,
  onOpenAudio,
  onOpenTimeline,
  onOpenSearch,
  onOpenStats,
  onOpenAccount,
  onOpenIdentity,
  onOpenPreferences,
}: HeaderBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const headerCardRef = useRef<HTMLDivElement>(null);

  const currentTheme = getThemeOption(theme);
  const handleAccountClick = onOpenAccount ?? onOpenIdentity;
  const isAuthenticated = Boolean(user && user.authProvider !== 'device');
  const accountLabel = isAuthenticated
    ? (user?.displayName ?? user?.username ?? user?.email ?? 'Mi cuenta')
    : 'Iniciar sesión';

  useEffect(() => {
    if (!menuOpen && !secondaryOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
      if (secondaryOpen && headerCardRef.current && !headerCardRef.current.contains(target)) {
        setSecondaryOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (menuOpen) {
        event.stopPropagation();
        setMenuOpen(false);
        return;
      }
      if (secondaryOpen) {
        event.stopPropagation();
        setSecondaryOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, secondaryOpen]);

  return (
    <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6">
      <div
        ref={headerCardRef}
        className="liquid-glass mx-auto max-w-6xl rounded-2xl px-3.5 py-2.5 sm:px-5"
      >
        {/* Always-visible primary header bar (never collapsible) */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent ring-4 ring-accent/25 sm:h-3 sm:w-3"
              aria-hidden="true"
            />
            <h1 className="truncate text-sm font-bold tracking-tight text-heading sm:text-lg">
              Deep-Work
            </h1>

            {!serverOnline && (
              <>
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full bg-danger sm:hidden"
                  title="Sin conexión"
                  aria-hidden="true"
                />
                <span
                  className="hidden items-center gap-1.5 rounded-full bg-danger-bg px-2.5 py-0.5 text-[11px] font-semibold text-danger sm:inline-flex"
                  role="status"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true" />
                  <span>Sin conexión</span>
                </span>
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {onOpenAudio && (
              <button
                type="button"
                onClick={onOpenAudio}
                className="liquid-pill hidden min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-heading md:inline-flex"
              >
                {isAudioPlaying && (
                  <span
                    className="h-2 w-2 animate-pulse rounded-full bg-accent"
                    aria-hidden="true"
                  />
                )}
                <span>Sonido</span>
              </button>
            )}

            {hasActiveSession && onOpenTimeline && (
              <button
                type="button"
                onClick={onOpenTimeline}
                className="liquid-pill hidden min-h-9 cursor-pointer items-center rounded-full px-3 py-1.5 text-xs font-semibold text-heading md:inline-flex"
              >
                Fases
              </button>
            )}

            {onOpenSearch && (
              <button
                type="button"
                onClick={onOpenSearch}
                className="liquid-pill hidden min-h-9 cursor-pointer items-center rounded-full px-3 py-1.5 text-xs font-semibold text-heading md:inline-flex"
              >
                Buscador
              </button>
            )}

            {onOpenStats && (
              <button
                type="button"
                onClick={onOpenStats}
                className="liquid-pill hidden min-h-9 cursor-pointer items-center rounded-full px-3 py-1.5 text-xs font-semibold text-heading md:inline-flex"
              >
                Estadísticas
              </button>
            )}

            {handleAccountClick && (
              <button
                type="button"
                onClick={handleAccountClick}
                className="liquid-pill hidden min-h-9 cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-heading md:inline-flex"
              >
                {isAuthenticated && user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={accountLabel}
                    className="h-4 w-4 shrink-0 rounded-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${isAuthenticated ? 'bg-success' : 'bg-muted'}`}
                    aria-hidden="true"
                  />
                )}
                <span className="max-w-20 truncate sm:max-w-28">{accountLabel}</span>
              </button>
            )}

            <div className="relative" ref={menuRef}>
              <button
                type="button"
                className="liquid-pill inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-semibold text-heading sm:gap-2 sm:px-3 sm:text-xs"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Seleccionar tema (${currentTheme.label})`}
                onClick={() => {
                  setSecondaryOpen(false);
                  setMenuOpen((prev) => !prev);
                }}
              >
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${currentTheme.swatchClass}`}
                  aria-hidden="true"
                />
                <span className="sm:hidden">Tema</span>
                <span className="hidden sm:inline">{currentTheme.headerLabel}</span>
                <span className="text-[10px] text-muted" aria-hidden="true">
                  ▾
                </span>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  aria-label="Paletas de temas"
                  className="liquid-menu-solid liquid-modal-panel absolute right-0 left-auto z-50 mt-2 w-64 max-w-[calc(100vw-32px)] rounded-2xl p-1.5"
                >
                  {APP_THEMES.map((option) => {
                    const isSelected = option.id === theme;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition ${
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
              className="liquid-pill hidden min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading md:inline-flex md:items-center"
              onClick={onOpenPreferences}
            >
              Preferencias
            </button>

            <button
              type="button"
              className="liquid-pill inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold text-heading md:hidden"
              aria-expanded={secondaryOpen}
              aria-controls="header-secondary-panel"
              aria-label="Opciones adicionales"
              onClick={() => {
                setMenuOpen(false);
                setSecondaryOpen((prev) => !prev);
              }}
            >
              <span>Más</span>
              <span className="text-[10px] text-muted" aria-hidden="true">
                {secondaryOpen ? '▴' : '▾'}
              </span>
            </button>
          </div>
        </div>

        {/* Collapsible secondary accordion panel with smooth open/close transition */}
        <div
          id="header-secondary-panel"
          data-open={secondaryOpen ? 'true' : 'false'}
          aria-hidden={!secondaryOpen}
          className={`liquid-accordion md:hidden ${secondaryOpen ? '' : 'pointer-events-none'}`}
        >
          <div className="liquid-accordion-inner">
            <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-edge/50 pt-2.5">
              {handleAccountClick && (
                <button
                  type="button"
                  tabIndex={secondaryOpen ? 0 : -1}
                  className="liquid-pill inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                  onClick={() => {
                    setSecondaryOpen(false);
                    handleAccountClick();
                  }}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${isAuthenticated ? 'bg-success' : 'bg-muted'}`}
                    aria-hidden="true"
                  />
                  <span>Cuenta y sesiones</span>
                </button>
              )}

              <button
                type="button"
                tabIndex={secondaryOpen ? 0 : -1}
                className="liquid-pill min-h-9 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                onClick={() => {
                  setSecondaryOpen(false);
                  onOpenPreferences();
                }}
              >
                Preferencias
              </button>

              {onOpenAudio && (
                <button
                  type="button"
                  tabIndex={secondaryOpen ? 0 : -1}
                  className="liquid-pill inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                  onClick={() => {
                    setSecondaryOpen(false);
                    onOpenAudio();
                  }}
                >
                  {isAudioPlaying && (
                    <span
                      className="h-2 w-2 animate-pulse rounded-full bg-accent"
                      aria-hidden="true"
                    />
                  )}
                  <span>Sonido</span>
                </button>
              )}

              {hasActiveSession && onOpenTimeline && (
                <button
                  type="button"
                  tabIndex={secondaryOpen ? 0 : -1}
                  className="liquid-pill min-h-9 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                  onClick={() => {
                    setSecondaryOpen(false);
                    onOpenTimeline();
                  }}
                >
                  Planificación
                </button>
              )}

              {onOpenSearch && (
                <button
                  type="button"
                  tabIndex={secondaryOpen ? 0 : -1}
                  className="liquid-pill min-h-9 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                  onClick={() => {
                    setSecondaryOpen(false);
                    onOpenSearch();
                  }}
                >
                  Buscador
                </button>
              )}

              {onOpenStats && (
                <button
                  type="button"
                  tabIndex={secondaryOpen ? 0 : -1}
                  className="liquid-pill min-h-9 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold text-heading"
                  onClick={() => {
                    setSecondaryOpen(false);
                    onOpenStats();
                  }}
                >
                  Estadísticas
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
});
