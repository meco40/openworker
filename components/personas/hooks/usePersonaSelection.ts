'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PersonaWithFiles, PersonaTabName } from '../../../src/server/personas/personaTypes';

interface UsePersonaSelectionOptions {
  activeTab: PersonaTabName;
}

interface UsePersonaSelectionReturn {
  selectedId: string | null;
  selectedPersona: PersonaWithFiles | null;
  setSelectedId: (id: string | null) => void;
  loadPersona: (id: string) => Promise<void>;
  preferredModelId: string | null;
  setPreferredModelId: (id: string | null) => void;
}

export function usePersonaSelection(
  options: UsePersonaSelectionOptions,
): UsePersonaSelectionReturn {
  const { activeTab } = options;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<PersonaWithFiles | null>(null);
  const [preferredModelId, setPreferredModelId] = useState<string | null>(null);

  const loadPersona = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/personas/${id}`);
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

  useEffect(() => {
    if (selectedId) {
      loadPersona(selectedId);
    } else {
      setSelectedPersona(null);
    }
  }, [selectedId, loadPersona, activeTab]);

  return {
    selectedId,
    selectedPersona,
    setSelectedId,
    loadPersona,
    preferredModelId,
    setPreferredModelId,
  };
}
