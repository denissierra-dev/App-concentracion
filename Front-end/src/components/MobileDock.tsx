import { memo } from 'react';

interface MobileDockProps {
  isAudioPlaying: boolean;
  hasActiveSession: boolean;
  onOpenAudio: () => void;
  onOpenTimeline: () => void;
  onOpenSearch: () => void;
  onOpenStats: () => void;
  onOpenPreferences: () => void;
}

export const MobileDock = memo(function MobileDock({
  isAudioPlaying,
  hasActiveSession,
  onOpenAudio,
  onOpenTimeline,
  onOpenSearch,
  onOpenStats,
  onOpenPreferences,
}: MobileDockProps) {
  return (
    <nav
      aria-label="Accesos rápidos"
      className="liquid-glass-strong fixed bottom-3 left-1/2 z-30 box-border flex w-[calc(100%-24px)] max-w-[calc(100vw-24px)] -translate-x-1/2 items-center justify-between gap-1 overflow-hidden rounded-2xl p-1.5 md:hidden"
    >
      <button
        type="button"
        onClick={onOpenAudio}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center rounded-xl px-1.5 py-1 text-[11px] font-semibold text-heading transition hover:bg-elevated/60 active:scale-95"
      >
        <span className="inline-flex max-w-full items-center gap-1 truncate">
          {isAudioPlaying && (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
              aria-hidden="true"
            />
          )}
          <span className="truncate">Sonido</span>
        </span>
      </button>

      {hasActiveSession && (
        <button
          type="button"
          onClick={onOpenTimeline}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-xl px-1.5 py-1 text-[11px] font-semibold text-heading transition hover:bg-elevated/60 active:scale-95"
        >
          <span className="truncate">Fases</span>
        </button>
      )}

      <button
        type="button"
        onClick={onOpenSearch}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-xl px-1.5 py-1 text-[11px] font-semibold text-heading transition hover:bg-elevated/60 active:scale-95"
      >
        <span className="truncate">Buscar</span>
      </button>

      <button
        type="button"
        onClick={onOpenStats}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-xl px-1.5 py-1 text-[11px] font-semibold text-heading transition hover:bg-elevated/60 active:scale-95"
      >
        <span className="truncate">Stats</span>
      </button>

      <button
        type="button"
        onClick={onOpenPreferences}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-xl px-1.5 py-1 text-[11px] font-semibold text-heading transition hover:bg-elevated/60 active:scale-95"
      >
        <span className="truncate">Ajustes</span>
      </button>
    </nav>
  );
});
