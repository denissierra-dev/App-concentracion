import { memo, useEffect } from 'react';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

export const TOAST_AUTO_DISMISS_MS = 5000;

interface ToastCardProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

const ToastCard = memo(function ToastCard({ toast, onDismiss }: ToastCardProps) {
  useEffect(() => {
    const timerId = window.setTimeout(() => {
      onDismiss(toast.id);
    }, TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timerId);
  }, [toast.id, onDismiss]);

  const toneClasses =
    toast.tone === 'error'
      ? 'border-danger/50 bg-danger-bg text-danger'
      : toast.tone === 'success'
        ? 'border-success/45 bg-success-bg text-success'
        : 'border-edge text-heading';

  return (
    <div
      className={`liquid-glass-strong liquid-toast-enter pointer-events-auto flex w-full max-w-sm items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm font-medium shadow-lg ${toneClasses}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Cerrar notificación"
        className="shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-xs font-semibold opacity-80 transition hover:bg-black/10 hover:opacity-100"
      >
        Cerrar
      </button>
    </div>
  );
});

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export const ToastStack = memo(function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Notificaciones"
      className="pointer-events-none fixed right-4 bottom-20 left-4 z-40 flex flex-col items-end gap-2.5 sm:right-6 sm:left-auto md:bottom-6"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
});
