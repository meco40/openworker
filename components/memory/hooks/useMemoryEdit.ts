'use client';

import { useCallback, useState } from 'react';
import type { MemoryNode } from '../../../core/memory/types';
import type { EditDraft } from '../types';

interface UseMemoryEditOptions {
  selectedPersonaId: string | null;
  nodes: MemoryNode[];
  reloadCurrent: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
}

export function useMemoryEdit(options: UseMemoryEditOptions) {
  const { selectedPersonaId, nodes, reloadCurrent, setErrorMessage } = options;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  const beginEdit = useCallback((node: MemoryNode) => {
    setEditingId(node.id);
    setDraft({
      content: node.content,
      type: node.type,
      importance: node.importance,
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!selectedPersonaId || !editingId || !draft) return;
    const current = nodes.find((node) => node.id === editingId) || null;
    if (!current) return;
    setSaving(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: selectedPersonaId,
          id: editingId,
          content: draft.content,
          type: draft.type,
          importance: draft.importance,
          expectedVersion: Number(current.metadata?.version || 1),
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (response.ok && payload.ok) {
        setErrorMessage(null);
        await reloadCurrent();
        cancelEdit();
      } else if (response.status === 409) {
        setErrorMessage(
          'Memory wurde parallel geändert. Bitte neu laden und Änderung erneut speichern.',
        );
        await reloadCurrent();
      } else {
        setErrorMessage(
          String(payload.error || `Speichern fehlgeschlagen (HTTP ${response.status}).`),
        );
      }
    } finally {
      setSaving(false);
    }
  }, [cancelEdit, draft, editingId, nodes, reloadCurrent, selectedPersonaId, setErrorMessage]);

  const deleteNode = useCallback(
    async (nodeId: string, onSuccess?: () => void) => {
      if (!selectedPersonaId) return;
      if (!window.confirm('Diese Memory wirklich löschen?')) return;
      setDeletingId(nodeId);
      try {
        const response = await fetch(
          `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}&id=${encodeURIComponent(nodeId)}`,
          { method: 'DELETE' },
        );
        if (response.ok) {
          onSuccess?.();
          await reloadCurrent();
        }
      } finally {
        setDeletingId(null);
      }
    },
    [reloadCurrent, selectedPersonaId],
  );

  const clearPersonaMemory = useCallback(
    async (onSuccess?: () => void) => {
      if (!selectedPersonaId) return;
      if (!window.confirm('Alle Memory-Einträge dieser Persona löschen?')) return;
      setClearingAll(true);
      try {
        const response = await fetch(
          `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}`,
          { method: 'DELETE' },
        );
        if (response.ok) {
          onSuccess?.();
          await reloadCurrent();
          cancelEdit();
        }
      } finally {
        setClearingAll(false);
      }
    },
    [cancelEdit, reloadCurrent, selectedPersonaId],
  );

  const updateDraftContent = useCallback((content: string) => {
    setDraft((prev) => (prev ? { ...prev, content } : prev));
  }, []);

  const updateDraftType = useCallback((type: EditDraft['type']) => {
    setDraft((prev) => (prev ? { ...prev, type } : prev));
  }, []);

  const updateDraftImportance = useCallback((importance: number) => {
    setDraft((prev) => (prev ? { ...prev, importance } : prev));
  }, []);

  return {
    editingId,
    draft,
    saving,
    deletingId,
    clearingAll,
    beginEdit,
    cancelEdit,
    saveEdit,
    deleteNode,
    clearPersonaMemory,
    updateDraftContent,
    updateDraftType,
    updateDraftImportance,
  };
}
