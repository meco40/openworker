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

interface UsePersonaSelectionOptions {
  loadPersonaById?: (id: string) => Promise<PersonaWithFiles | null>;
  onPersonaFilePatched?: (id: string, filename: PersonaFileName, content: string) => void;
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

export function usePersonaSelection(
  options: UsePersonaSelectionOptions = {},
): UsePersonaSelectionReturn {
  const { loadPersonaById, onPersonaFilePatched } = options;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<PersonaWithFiles | null>(null);
  const [preferredModelId, setPreferredModelId] = useState<string | null>(null);

  const loadPersona = useCallback(
    async (id: string) => {
      const loader = loadPersonaById;
      try {
        if (loader) {
          const persona = await loader(id);
          if (!persona) return;
          setSelectedPersona(persona);
          setPreferredModelId(persona.preferredModelId ?? null);
          return;
        }
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
    },
    [loadPersonaById],
  );

  const patchSelectedPersonaFile = useCallback(
    (filename: PersonaFileName, content: string) => {
      setSelectedPersona((current) => applySavedPersonaFile(current, filename, content));
      if (selectedId) {
        onPersonaFilePatched?.(selectedId, filename, content);
      }
    },
    [onPersonaFilePatched, selectedId],
  );

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
