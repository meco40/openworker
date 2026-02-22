'use client';

import { useCallback, useState } from 'react';
import type { MemoryNode } from '@/core/memory/types';
import type { EditDraft } from '@/components/memory/types';

interface UseMemoryEditOptions {
  selectedPersonaId: string | null;
  nodes: MemoryNode[];
  reloadCurrent: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
}

interface MemorySnapshotResponse {
  ok?: boolean;
  nodes?: MemoryNode[];
  error?: string;
}

interface MemoryDeleteResponse {
  ok?: boolean;
  deleted?: number;
  error?: string;
}

const DELETE_ALL_CONFIRM_TOKEN = 'delete-all-memory';
const DELETE_CONFIRMATION_PHRASE = 'DELETE';

function buildMemoryBackupFileName(personaId: string): string {
  const safePersonaId = personaId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `memory-backup-${safePersonaId}-${stamp}.json`;
}

async function exportPersonaMemorySnapshot(
  personaId: string,
): Promise<{ fileName: string; nodeCount: number }> {
  const response = await fetch(`/api/memory?personaId=${encodeURIComponent(personaId)}`, {
    cache: 'no-store',
  });
  const payload = (await response.json()) as MemorySnapshotResponse;
  if (!response.ok || !payload.ok || !Array.isArray(payload.nodes)) {
    throw new Error(String(payload.error || `Backup export failed (HTTP ${response.status}).`));
  }

  const fileName = buildMemoryBackupFileName(personaId);
  const exportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    personaId,
    nodeCount: payload.nodes.length,
    nodes: payload.nodes,
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(objectUrl);

  return { fileName, nodeCount: payload.nodes.length };
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
      const firstConfirm = window.confirm(
        'Vor dem Loeschen wird ein JSON-Backup exportiert. Danach folgt eine zweite Sicherheitsabfrage. Fortfahren?',
      );
      if (!firstConfirm) return;

      setClearingAll(true);
      try {
        const { fileName, nodeCount } = await exportPersonaMemorySnapshot(selectedPersonaId);
        const secondConfirm = window.prompt(
          `Backup exportiert (${nodeCount} Eintraege, Datei: ${fileName}). Gib ${DELETE_CONFIRMATION_PHRASE} ein, um alle Persona-Memory-Eintraege endgueltig zu loeschen.`,
          '',
        );
        if (
          String(secondConfirm || '')
            .trim()
            .toUpperCase() !== DELETE_CONFIRMATION_PHRASE
        ) {
          setErrorMessage('Loeschen abgebrochen. Keine Memory-Eintraege wurden entfernt.');
          return;
        }

        const response = await fetch(
          `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}&confirm=${encodeURIComponent(DELETE_ALL_CONFIRM_TOKEN)}`,
          { method: 'DELETE' },
        );
        const payload = (await response.json()) as MemoryDeleteResponse;
        if (response.ok && payload.ok) {
          setErrorMessage(null);
          onSuccess?.();
          await reloadCurrent();
          cancelEdit();
        } else {
          setErrorMessage(
            String(payload.error || `Loeschen fehlgeschlagen (HTTP ${response.status}).`),
          );
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Backup export oder Loeschen fehlgeschlagen.',
        );
      } finally {
        setClearingAll(false);
      }
    },
    [cancelEdit, reloadCurrent, selectedPersonaId, setErrorMessage],
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
