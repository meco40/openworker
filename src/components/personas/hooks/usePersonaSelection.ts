'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PersonaFileName, PersonaWithFiles } from '@/server/personas/personaTypes';

interface UsePersonaSelectionReturn {
  selectedId: string | null;
  selectedPersona: PersonaWithFiles | null;
  setSelectedId: (id: string | null) => void;
  loadPersona: (id: string) => Promise<void>;
  patchSelectedPersonaFile: (filename: PersonaFileName, content: string) => void;
  preferredModelId: string | null;
  setPreferredModelId: (id: string | null) => void;
}

export function applySavedPersonaFile(
  persona: PersonaWithFiles | null,
  filename: PersonaFileName,
  content: string,
): PersonaWithFiles | null {
  if (!persona) return persona;
  return {
    ...persona,
    files: {
      ...persona.files,
      [filename]: content,
    },
  };
}

export function usePersonaSelection(): UsePersonaSelectionReturn {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<PersonaWithFiles | null>(null);
  const [preferredModelId, setPreferredModelId] = useState<string | null>(null);

  const loadPersona = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/personas/${id}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const p = data.persona as PersonaWithFiles;
        setSelectedPersona(p);
        setPreferredModelId(p.preferredModelId ?? null);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const patchSelectedPersonaFile = useCallback((filename: PersonaFileName, content: string) => {
    setSelectedPersona((current) => applySavedPersonaFile(current, filename, content));
  }, []);

  useEffect(() => {
    if (selectedId) {
      loadPersona(selectedId);
    } else {
      setSelectedPersona(null);
    }
  }, [selectedId, loadPersona]);

  return {
    selectedId,
    selectedPersona,
    setSelectedId,
    loadPersona,
    patchSelectedPersonaFile,
    preferredModelId,
    setPreferredModelId,
  };
}
