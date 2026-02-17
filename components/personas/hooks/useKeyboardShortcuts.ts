'use client';

import { useEffect } from 'react';

interface UseKeyboardShortcutsOptions {
  dirty: boolean;
  selectedId: string | null;
  activeTab: string;
  onSave: () => void;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
  const { dirty, selectedId, activeTab, onSave } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 's' &&
        dirty &&
        selectedId &&
        activeTab !== 'GATEWAY'
      ) {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, selectedId, activeTab, onSave]);
}
