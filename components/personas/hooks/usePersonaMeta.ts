'use client';

import { useCallback, useState } from 'react';
import type { PersonaWithFiles } from '../../../src/server/personas/personaTypes';

interface UsePersonaMetaOptions {
  selectedId: string | null;
  selectedPersona: PersonaWithFiles | null;
  refreshPersonas: () => Promise<void>;
  loadPersona: (id: string) => Promise<void>;
}

interface UsePersonaMetaReturn {
  editingMeta: boolean;
  setEditingMeta: (editing: boolean) => void;
  metaName: string;
  setMetaName: (name: string) => void;
  metaEmoji: string;
  setMetaEmoji: (emoji: string) => void;
  metaVibe: string;
  setMetaVibe: (vibe: string) => void;
  saving: boolean;
  startEditMeta: () => void;
  saveMeta: () => Promise<void>;
}

export function usePersonaMeta(options: UsePersonaMetaOptions): UsePersonaMetaReturn {
  const { selectedId, selectedPersona, refreshPersonas, loadPersona } = options;
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState('');
  const [metaEmoji, setMetaEmoji] = useState('');
  const [metaVibe, setMetaVibe] = useState('');
  const [saving, setSaving] = useState(false);

  const startEditMeta = useCallback(() => {
    if (selectedPersona) {
      setMetaName(selectedPersona.name);
      setMetaEmoji(selectedPersona.emoji);
      setMetaVibe(selectedPersona.vibe);
      setEditingMeta(true);
    }
  }, [selectedPersona]);

  const saveMeta = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/personas/${selectedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: metaName, emoji: metaEmoji, vibe: metaVibe }),
      });
      if (res.ok) {
        setEditingMeta(false);
        await refreshPersonas();
        await loadPersona(selectedId);
      }
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [selectedId, metaName, metaEmoji, metaVibe, refreshPersonas, loadPersona]);

  return {
    editingMeta,
    setEditingMeta,
    metaName,
    setMetaName,
    metaEmoji,
    setMetaEmoji,
    metaVibe,
    setMetaVibe,
    saving,
    startEditMeta,
    saveMeta,
  };
}
