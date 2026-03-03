'use client';

import { useCallback, useMemo, useState } from 'react';
import type { MemoryNode, MemoryType } from '@/core/memory/types';
import { useConfirmDialog } from '@/components/shared/ConfirmDialogProvider';

interface UseBulkOperationsOptions {
  nodes: MemoryNode[];
  selectedPersonaId: string | null;
  reloadCurrent: () => Promise<void>;
}

export function useBulkOperations(options: UseBulkOperationsOptions) {
  const { nodes, selectedPersonaId, reloadCurrent } = options;
  const confirm = useConfirmDialog();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkType, setBulkType] = useState<'keep' | MemoryType>('keep');
  const [bulkImportance, setBulkImportance] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const allPageSelected = useMemo(
    () => nodes.length > 0 && nodes.every((node) => selectedIdSet.has(node.id)),
    [nodes, selectedIdSet],
  );

  const toggleNodeSelection = useCallback((nodeId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return Array.from(next);
    });
  }, []);

  const toggleSelectPage = useCallback(() => {
    const pageIds = nodes.map((node) => node.id);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (pageIds.every((id) => next.has(id))) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return Array.from(next);
    });
  }, [nodes]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const applyBulkUpdate = useCallback(async () => {
    if (!selectedPersonaId || selectedIds.length === 0) return;
    const payload: Record<string, unknown> = {
      personaId: selectedPersonaId,
      ids: selectedIds,
      action: 'update',
    };
    if (bulkType !== 'keep') {
      payload.type = bulkType;
    }
    if (bulkImportance.trim()) {
      payload.importance = Number(bulkImportance);
    }
    if (!('type' in payload) && !('importance' in payload)) {
      return;
    }
    setBulkBusy(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setSelectedIds([]);
        await reloadCurrent();
      }
    } finally {
      setBulkBusy(false);
    }
  }, [bulkImportance, bulkType, reloadCurrent, selectedIds, selectedPersonaId]);

  const applyBulkDelete = useCallback(async () => {
    if (!selectedPersonaId || selectedIds.length === 0) return;
    const confirmed = await confirm({
      title: 'Memory-Einträge löschen?',
      description: `Ausgewählte ${selectedIds.length} Memory-Einträge löschen?`,
      confirmLabel: 'Löschen',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBulkBusy(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: selectedPersonaId,
          ids: selectedIds,
          action: 'delete',
        }),
      });
      if (response.ok) {
        setSelectedIds([]);
        await reloadCurrent();
      }
    } finally {
      setBulkBusy(false);
    }
  }, [confirm, reloadCurrent, selectedIds, selectedPersonaId]);

  return {
    selectedIds,
    selectedIdSet,
    allPageSelected,
    bulkType,
    setBulkType,
    bulkImportance,
    setBulkImportance,
    bulkBusy,
    toggleNodeSelection,
    toggleSelectPage,
    clearSelection,
    applyBulkUpdate,
    applyBulkDelete,
  };
}
