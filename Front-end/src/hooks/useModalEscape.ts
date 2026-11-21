import { useEffect, type RefObject } from 'react';

/**
 * Closes a modal on Escape only when no dropdown menu is open above it
 * and this dialog is the topmost modal in DOM stacking order.
 */
export function useModalEscape(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  disabled = false
): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || disabled) {
        return;
      }

      if (document.querySelector('[role="menu"]')) {
        return;
      }

      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const topmost = dialogs[dialogs.length - 1];
      if (topmost && dialogRef.current && topmost !== dialogRef.current) {
        return;
      }

      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dialogRef, disabled, onClose]);
}
