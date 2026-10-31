'use client';

import { useEffect } from 'react';

/**
 * Calls `onEscape` when Escape is pressed anywhere while `enabled` is true.
 *
 * Dialogs listen on the window instead of the dialog element, so Escape works
 * wherever focus sits while the dialog is open.
 */
export function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onEscape]);
}
