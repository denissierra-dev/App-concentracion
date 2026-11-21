import { memo } from 'react';
import type { AudioTrack, PhaseType, VolumePolicy } from '../domain/types';

interface AudioPlayerProps {
  tracks: AudioTrack[];
  selectedTrackId: string;
  isPlaying: boolean;
  isMuted: boolean;
  localScale: number;
  policyVolume: number;
  effectiveTargetVolume: number;
  volumePolicy: VolumePolicy;
  activePhaseType: PhaseType | null;
  audioError: string | null;
  embedded?: boolean;
  onSelectTrack: (trackId: string) => void;
  onTogglePlay: () => Promise<void>;
  onToggleMute: () => void;
  onChangeLocalScale: (value: number) => void;
}

const CATEGORY_LABELS: Record<AudioTrack['category'], string> = {
  ambient: 'Ambiente',
  noise: 'Ruido',
  drone: 'Drone',
};

export const AudioPlayer = memo(function AudioPlayer({
  tracks,
  selectedTrackId,
  isPlaying,
  isMuted,
  localScale,
  policyVolume,
  effectiveTargetVolume,
  volumePolicy,
  activePhaseType,
  audioError,
  embedded = false,
  onSelectTrack,
  onTogglePlay,
  onToggleMute,
  onChangeLocalScale,
}: AudioPlayerProps) {
  const effectivePct = Math.round(effectiveTargetVolume * 100);
  const policyPct = Math.round(policyVolume * 100);

  const content = (
    <>
      {!embedded && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 id="audio-heading" className="text-base font-bold text-heading">
            Sonido ambiental
          </h2>
          <span className="liquid-glass-subtle inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold text-ink">
            {activePhaseType && activePhaseType !== 'focus' ? 'Descanso' : 'Enfoque'}: {policyPct}%
          </span>
        </div>
      )}

      {tracks.length === 0 ? (
        <p className="text-sm text-muted">Cargando pistas disponibles...</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Pistas disponibles">
            {tracks.map((track) => {
              const selected = track.id === selectedTrackId;
              return (
                <button
                  key={track.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`flex min-h-11 w-full cursor-pointer items-center justify-between rounded-2xl border px-4 py-2.5 text-left transition ${
                    selected
                      ? 'border-brand bg-brand/15 ring-1 ring-brand/30'
                      : 'liquid-glass-subtle hover:border-brand'
                  }`}
                  onClick={() => onSelectTrack(track.id)}
                >
                  <span className="text-sm font-semibold text-heading">{track.title}</span>
                  <span className="text-xs text-muted">{CATEGORY_LABELS[track.category]}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className={`min-h-11 flex-1 cursor-pointer rounded-full px-5 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55 ${
                isPlaying
                  ? 'bg-brand text-brand-ink hover:bg-brand-hover'
                  : 'bg-accent font-bold text-accent-ink hover:bg-accent-hover'
              }`}
              onClick={() => void onTogglePlay()}
              disabled={!selectedTrackId}
            >
              {isPlaying ? 'Detener audio' : 'Reproducir loop'}
            </button>

            <button
              type="button"
              className="liquid-pill min-h-11 cursor-pointer rounded-full px-5 py-2.5 text-sm font-semibold text-heading"
              onClick={onToggleMute}
            >
              {isMuted ? 'Activar sonido' : 'Silenciar'}
            </button>
          </div>

          <div className="liquid-glass-subtle flex flex-col gap-1.5 rounded-2xl p-3.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="local-volume-slider" className="font-semibold text-heading">
                Volumen local
              </label>
              <span className="font-mono text-muted">{effectivePct}% efectivo</span>
            </div>
            <input
              id="local-volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={localScale}
              onChange={(e) => onChangeLocalScale(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <p className="text-xs text-muted">
              Volumen automático: Enfoque {Math.round(volumePolicy.focus * 100)}% · Descanso{' '}
              {Math.round(volumePolicy.short_break * 100)}%
            </p>
          </div>

          {audioError && (
            <p
              className="rounded-2xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
              role="alert"
            >
              {audioError}
            </p>
          )}
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div aria-label="Sonido ambiental">{content}</div>;
  }

  return (
    <section
      className="liquid-glass rounded-3xl p-6"
      aria-labelledby="audio-heading"
    >
      {content}
    </section>
  );
});
