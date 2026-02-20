'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PersonaTabName, PersonaWithFiles } from '@/server/personas/personaTypes';

interface UsePersonaEditorOptions {
  selectedId: string | null;
  selectedPersona: PersonaWithFiles | null;
  activeTab: PersonaTabName;
}

interface UsePersonaEditorReturn {
  editorContent: string;
  setEditorContent: (content: string) => void;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
  saveFile: () => Promise<void>;
}

export function usePersonaEditor(options: UsePersonaEditorOptions): UsePersonaEditorReturn {
  const { selectedId, selectedPersona, activeTab } = options;
  const [editorContent, setEditorContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load content when switching tabs or persona
  useEffect(() => {
    if (selectedPersona && activeTab !== 'GATEWAY') {
      setEditorContent(selectedPersona.files[activeTab] ?? '');
      setDirty(false);
    }
  }, [activeTab, selectedPersona]);

  const saveFile = useCallback(async () => {
    if (!selectedId || activeTab === 'GATEWAY') return;
    setSaving(true);
    try {
      await fetch(`/api/personas/${selectedId}/files/${activeTab}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorContent }),
      });
      setDirty(false);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [selectedId, activeTab, editorContent]);

  return {
    editorContent,
    setEditorContent,
    dirty,
    setDirty,
    saving,
    saveFile,
  };
}
