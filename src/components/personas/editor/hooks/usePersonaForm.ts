'use client';

import { useCallback } from 'react';
import type { PersonaTabName } from '@/server/personas/personaTypes';

interface UsePersonaFormProps {
  setEditorContent: (value: string) => void;
  setDirty: (value: boolean) => void;
  setActiveTab: (tab: PersonaTabName) => void;
}

export function usePersonaForm({ setEditorContent, setDirty, setActiveTab }: UsePersonaFormProps) {
  const handleTabChange = useCallback(
    (tabName: PersonaTabName) => {
      if (typeof window !== 'undefined') {
        // Note: dirty check is handled by the caller
        setActiveTab(tabName);
      }
    },
    [setActiveTab],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      setEditorContent(value);
      setDirty(true);
    },
    [setEditorContent, setDirty],
  );

  return {
    handleTabChange,
    handleEditorChange,
  };
}
