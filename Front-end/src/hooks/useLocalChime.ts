import { useCallback, useRef } from 'react';
import type { PhaseType } from '../domain/types';
import { sanitizePlainText } from '../security/validators';

export function useLocalChime() {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playTransitionChime = useCallback((nextPhase: PhaseType | 'completed') => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        return;
      }

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const now = ctx.currentTime;
      const notes =
        nextPhase === 'focus'
          ? [523.25, 659.25] // C5 -> E5 (energizing start)
          : nextPhase === 'completed'
            ? [523.25, 659.25, 783.99] // C5 -> E5 -> G5 (session finished)
            : [659.25, 493.88]; // E5 -> B4 (calm break)

      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.14);

        gain.gain.setValueAtTime(0.0001, now + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.12, now + idx * 0.14 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.45);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.14);
        osc.stop(now + idx * 0.14 + 0.48);
      });
    } catch {
      // Ignore Web Audio failures if autoplay policy blocks audio before user gesture
    }
  }, []);

  const notifyLocal = useCallback((title: string, body: string, enabled: boolean) => {
    if (!enabled || typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }
    if (Notification.permission !== 'granted') {
      return;
    }

    try {
      new Notification(sanitizePlainText(title, 80), {
        body: sanitizePlainText(body, 160),
        tag: 'deep-work-phase',
      });
    } catch {
      // Ignore notification errors
    }
  }, []);

  const requestNotificationPermission = useCallback(async (): Promise<NotificationPermission | 'unsupported'> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    try {
      return await Notification.requestPermission();
    } catch {
      return 'default';
    }
  }, []);

  return {
    playTransitionChime,
    notifyLocal,
    requestNotificationPermission,
  };
}
