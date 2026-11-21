import { useRef, type ReactNode } from 'react';
import { useModalEscape } from '../hooks/useModalEscape';

interface GlassModalProps {
  titleId: string;
  title: string;
  subtitle?: string;
  maxWidthClass?: string;
  placement?: 'bottom' | 'center' | 'top-center';
  onClose: () => void;
  children: ReactNode;
}

const PLACEMENT_CONTAINER_CLASSES: Record<NonNullable<GlassModalProps['placement']>, string> = {
  bottom: 'items-end justify-center p-2 sm:items-center sm:p-4',
  center: 'items-center justify-center p-3 sm:p-4',
  'top-center': 'items-start justify-center px-3 pt-12 pb-6 sm:items-center sm:p-4 sm:pb-16',
};

const PLACEMENT_PANEL_CLASSES: Record<NonNullable<GlassModalProps['placement']>, string> = {
  bottom: 'max-h-[88dvh] rounded-t-3xl sm:rounded-3xl',
  center: 'max-h-[88dvh] rounded-3xl',
  'top-center': 'max-h-[82dvh] rounded-3xl',
};

export function GlassModal({
  titleId,
  title,
  subtitle,
  maxWidthClass = 'max-w-xl',
  placement = 'bottom',
  onClose,
  children,
}: GlassModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalEscape(dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      className={`liquid-backdrop fixed inset-0 z-50 flex ${PLACEMENT_CONTAINER_CLASSES[placement]}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`liquid-glass-strong liquid-modal-panel w-full ${maxWidthClass} ${PLACEMENT_PANEL_CLASSES[placement]} overflow-y-auto p-5 sm:p-6`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-bold text-heading sm:text-lg">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="liquid-pill min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
