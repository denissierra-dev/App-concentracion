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

export function AudioPlayer({
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
  onSelectTrack,
  onTogglePlay,
  onToggleMute,
  onChangeLocalScale,
}: AudioPlayerProps) {
  const effectivePct = Math.round(effectiveTargetVolume * 100);
  const policyPct = Math.round(policyVolume * 100);

  return (
    <section
      className="rounded-2xl border border-edge bg-surface p-6 shadow-sm"
      aria-labelledby="audio-heading"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="audio-heading" className="text-base font-bold text-heading">
          Audio de concentración
        </h2>
        <span className="inline-flex items-center rounded-full bg-elevated px-3 py-1 text-xs font-semibold text-ink">
          Política {activePhaseType && activePhaseType !== 'focus' ? 'Descanso' : 'Enfoque'}:{' '}
          {policyPct}%
        </span>
      </div>

      {tracks.length === 0 ? (
        <p className="text-sm text-muted">Cargando pistas desde el servidor...</p>
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
                  className={`flex w-full cursor-pointer items-center justify-between rounded-lg border px-3.5 py-2.5 text-left transition ${
                    selected
                      ? 'border-brand bg-elevated'
                      : 'border-edge bg-canvas hover:border-brand'
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
              className={`cursor-pointer rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55 ${
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
              className="cursor-pointer rounded-xl border border-edge bg-elevated px-4 py-2.5 text-sm font-semibold text-heading transition hover:border-brand"
              onClick={onToggleMute}
            >
              {isMuted ? 'Activar sonido' : 'Silenciar'}
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="local-volume-slider" className="font-semibold text-heading">
                Ajuste local temporal (sin round-trip)
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
              Política en back-end: Enfoque {Math.round(volumePolicy.focus * 100)}% · Descanso{' '}
              {Math.round(volumePolicy.short_break * 100)}%
            </p>
          </div>

          {audioError && (
            <p
              className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
              role="alert"
            >
              {audioError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
