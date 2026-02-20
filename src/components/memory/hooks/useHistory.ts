'use client';

import { useCallback, useState } from 'react';
import type { MemoryNode } from '@/core/memory/types';
import type { MemoryHistoryEntry, MemoryHistoryResponse } from '@/components/memory/types';

interface UseHistoryOptions {
  selectedPersonaId: string | null;
  reloadCurrent: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
}

export function useHistory(options: UseHistoryOptions) {
  const { selectedPersonaId, reloadCurrent, setErrorMessage } = options;

  const [historyById, setHistoryById] = useState<Record<string, MemoryHistoryEntry[]>>({});
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (nodeId: string): Promise<MemoryHistoryEntry[]> => {
      if (!selectedPersonaId) return [];
      setHistoryLoadingId(nodeId);
      try {
        const response = await fetch(
          `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}&id=${encodeURIComponent(nodeId)}&history=1`,
          { cache: 'no-store' },
        );
        const payload = (await response.json()) as MemoryHistoryResponse;
        if (!response.ok || !payload.ok || !Array.isArray(payload.history)) {
          setErrorMessage(
            String(
              payload.error || `History konnte nicht geladen werden (HTTP ${response.status}).`,
            ),
          );
          return [];
        }
        setErrorMessage(null);
        setHistoryById((previous) => ({ ...previous, [nodeId]: payload.history || [] }));
        return payload.history || [];
      } catch {
        setErrorMessage('History konnte nicht geladen werden.');
        return [];
      } finally {
        setHistoryLoadingId(null);
      }
    },
    [selectedPersonaId, setErrorMessage],
  );

  const toggleHistory = useCallback(
    async (nodeId: string) => {
      if (expandedHistoryId === nodeId) {
        setExpandedHistoryId(null);
        return;
      }
      setExpandedHistoryId(nodeId);
      if (!historyById[nodeId]) {
        await loadHistory(nodeId);
      }
    },
    [expandedHistoryId, historyById, loadHistory],
  );

  const restoreFromHistory = useCallback(
    async (node: MemoryNode, entry: MemoryHistoryEntry) => {
      if (!selectedPersonaId) return;
      setRestoringId(node.id);
      try {
        const response = await fetch('/api/memory', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personaId: selectedPersonaId,
            id: node.id,
            restoreIndex: entry.index,
            expectedVersion: Number(node.metadata?.version || 1),
          }),
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          if (response.status === 409) {
            setErrorMessage(
              'Memory wurde parallel geändert. Bitte neu laden und erneut wiederherstellen.',
            );
            await reloadCurrent();
            await loadHistory(node.id);
            return;
          }
          setErrorMessage(
            String(payload.error || `Restore fehlgeschlagen (HTTP ${response.status}).`),
          );
          return;
        }
        setErrorMessage(null);
        await reloadCurrent();
        await loadHistory(node.id);
      } finally {
        setRestoringId(null);
      }
    },
    [loadHistory, reloadCurrent, selectedPersonaId, setErrorMessage],
  );

  const clearHistoryForNode = useCallback(
    (nodeId: string) => {
      setHistoryById((previous) => {
        const next = { ...previous };
        delete next[nodeId];
        return next;
      });
      if (expandedHistoryId === nodeId) {
        setExpandedHistoryId(null);
      }
    },
    [expandedHistoryId],
  );

  const clearAllHistory = useCallback(() => {
    setHistoryById({});
    setExpandedHistoryId(null);
  }, []);

  return {
    historyById,
    expandedHistoryId,
    historyLoadingId,
    restoringId,
    loadHistory,
    toggleHistory,
    restoreFromHistory,
    clearHistoryForNode,
    clearAllHistory,
  };
}
