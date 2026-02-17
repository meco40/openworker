'use client';

import { useCallback, useState } from 'react';
import type { PersonaWithFiles } from '../../../src/server/personas/personaTypes';

interface UsePersonaCRUDOptions {
  selectedId: string | null;
  selectedPersona: PersonaWithFiles | null;
  refreshPersonas: () => Promise<void>;
  setSelectedId: (id: string | null) => void;
  setActivePersonaId: (id: string | null) => void;
  activePersonaId: string | null;
}

interface UsePersonaCRUDReturn {
  creating: boolean;
  createPersona: (
    name: string,
    emoji: string,
    vibe: string,
    files?: Record<string, string>,
  ) => Promise<void>;
  duplicatePersona: () => Promise<void>;
  deletePersona: () => Promise<void>;
}

export function usePersonaCRUD(options: UsePersonaCRUDOptions): UsePersonaCRUDReturn {
  const {
    selectedId,
    selectedPersona,
    refreshPersonas,
    setSelectedId,
    setActivePersonaId,
    activePersonaId,
  } = options;
  const [creating, setCreating] = useState(false);

  const createPersona = useCallback(
    async (name: string, emoji: string, vibe: string, files?: Record<string, string>) => {
      setCreating(true);
      try {
        const res = await fetch('/api/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji, vibe, files }),
        });
        if (res.ok) {
          const data = await res.json();
          await refreshPersonas();
          setSelectedId(data.persona.id);
        }
      } catch {
        /* ignore */
      } finally {
        setCreating(false);
      }
    },
    [refreshPersonas, setSelectedId],
  );

  const duplicatePersona = useCallback(async () => {
    if (!selectedId || !selectedPersona) return;
    setCreating(true);
    try {
      const res = await fetch('/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${selectedPersona.name} Kopie`,
          emoji: selectedPersona.emoji,
          vibe: selectedPersona.vibe,
          files: selectedPersona.files,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await refreshPersonas();
        setSelectedId(data.persona.id);
      }
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [selectedId, selectedPersona, refreshPersonas, setSelectedId]);

  const deletePersona = useCallback(async () => {
    if (!selectedId) return;
    if (!window.confirm('Persona endgültig löschen?')) return;
    try {
      await fetch(`/api/personas/${selectedId}`, { method: 'DELETE' });
      if (activePersonaId === selectedId) setActivePersonaId(null);
      setSelectedId(null);
      await refreshPersonas();
    } catch {
      /* ignore */
    }
  }, [selectedId, activePersonaId, setActivePersonaId, refreshPersonas, setSelectedId]);

  return {
    creating,
    createPersona,
    duplicatePersona,
    deletePersona,
  };
}
