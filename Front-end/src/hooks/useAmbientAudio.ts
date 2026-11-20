import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioTrack, PhaseType, VolumePolicy } from '../domain/types';
import { safeStorage } from '../security/safeStorage';
import { assertSafeAudioStreamUrl } from '../security/validators';

interface UseAmbientAudioOptions {
  tracks: AudioTrack[];
  volumePolicy: VolumePolicy;
  activePhaseType: PhaseType | null;
}

const FADE_STEPS = 12;
const FADE_INTERVAL_MS = 35;

export function useAmbientAudio({
  tracks,
  volumePolicy,
  activePhaseType,
}: UseAmbientAudioOptions) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fadeTimerRef = useRef<number | null>(null);

  const [selectedTrackId, setSelectedTrackId] = useState<string>(() => {
    return safeStorage.getSelectedTrackId() ?? '';
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [isMuted, setIsMuted] = useState<boolean>(() => safeStorage.getLocalMuted());
  const [localScale, setLocalScale] = useState<number>(1);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Resolve default track once catalog loads
  useEffect(() => {
    if (tracks.length === 0) {
      return;
    }
    const exists = tracks.some((t) => t.id === selectedTrackId);
    if (!exists && tracks[0]) {
      setSelectedTrackId(tracks[0].id);
      safeStorage.setSelectedTrackId(tracks[0].id);
    }
  }, [tracks, selectedTrackId]);

  const policyVolume = activePhaseType ? volumePolicy[activePhaseType] : volumePolicy.focus;
  const effectiveTargetVolume = isMuted
    ? 0
    : Math.max(0, Math.min(1, policyVolume * localScale));

  const clearFade = useCallback(() => {
    if (fadeTimerRef.current !== null) {
      window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const fadeTo = useCallback(
    (audio: HTMLAudioElement, target: number, onComplete?: () => void) => {
      clearFade();
      const clampedTarget = Math.max(0, Math.min(1, target));
      const start = audio.volume;
      const diff = clampedTarget - start;

      if (Math.abs(diff) < 0.01) {
        audio.volume = clampedTarget;
        onComplete?.();
        return;
      }

      let step = 0;
      fadeTimerRef.current = window.setInterval(() => {
        step += 1;
        const nextVol = start + (diff * step) / FADE_STEPS;
        audio.volume = Math.max(0, Math.min(1, nextVol));
        if (step >= FADE_STEPS) {
          clearFade();
          audio.volume = clampedTarget;
          onComplete?.();
        }
      }, FADE_INTERVAL_MS);
    },
    [clearFade]
  );

  // Initialize and preload selected track securely
  useEffect(() => {
    const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
    if (!selectedTrack) {
      return;
    }

    let safeUrl: string;
    try {
      safeUrl = assertSafeAudioStreamUrl(selectedTrack.streamUrl);
    } catch {
      setAudioError('URL de audio bloqueada por política de seguridad');
      return;
    }

    const prevAudio = audioRef.current;
    if (prevAudio) {
      prevAudio.pause();
      prevAudio.removeAttribute('src');
      prevAudio.load();
    }

    const audio = new Audio();
    audio.preload = 'auto';
    audio.loop = true;
    audio.volume = 0;
    audio.src = safeUrl;
    audio.load();

    const handleError = () => {
      setAudioError('No se pudo cargar la pista de audio');
      isPlayingRef.current = false;
      setIsPlaying(false);
    };
    const handleCanPlay = () => {
      setAudioError(null);
    };

    audio.addEventListener('error', handleError);
    audio.addEventListener('canplay', handleCanPlay);
    audioRef.current = audio;

    if (isPlayingRef.current) {
      void audio
        .play()
        .then(() => {
          if (isPlayingRef.current) {
            fadeTo(audio, effectiveTargetVolume);
          } else {
            audio.pause();
          }
        })
        .catch(() => {
          isPlayingRef.current = false;
          setIsPlaying(false);
        });
    }

    return () => {
      clearFade();
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.pause();
      audio.removeAttribute('src');
    };
    // Intentionally re-run only when selectedTrackId or tracks list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrackId, tracks]);

  // Apply authoritative phase volume policy & local override smoothly
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) {
      return;
    }
    fadeTo(audio, effectiveTargetVolume);
  }, [effectiveTargetVolume, isPlaying, fadeTo]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setAudioError(null);

    if (isPlayingRef.current) {
      // Mark stopped immediately so switching tracks during fade-out never restarts playback
      isPlayingRef.current = false;
      setIsPlaying(false);
      fadeTo(audio, 0, () => {
        audio.pause();
      });
      return;
    }

    try {
      audio.volume = 0;
      isPlayingRef.current = true;
      setIsPlaying(true);
      await audio.play();
      if (isPlayingRef.current) {
        fadeTo(audio, effectiveTargetVolume);
      } else {
        audio.pause();
      }
    } catch {
      isPlayingRef.current = false;
      setIsPlaying(false);
      setAudioError('El navegador bloqueó la reproducción automática; intenta de nuevo');
    }
  }, [effectiveTargetVolume, fadeTo]);

  const selectTrack = useCallback((trackId: string) => {
    if (safeStorage.setSelectedTrackId(trackId)) {
      setSelectedTrackId(trackId);
      setAudioError(null);
    }
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      safeStorage.setLocalMuted(next);
      return next;
    });
  }, []);

  const setLocalVolumeScale = useCallback((value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    setLocalScale(Math.max(0, Math.min(1, value)));
  }, []);

  return {
    selectedTrackId,
    isPlaying,
    isMuted,
    localScale,
    policyVolume,
    effectiveTargetVolume,
    audioError,
    togglePlay,
    selectTrack,
    toggleMute,
    setLocalVolumeScale,
  };
}
