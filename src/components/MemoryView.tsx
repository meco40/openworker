'use client';

import React, { useEffect, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { MemoryType } from '@/core/memory/types';
import { useMemory, useHistory, useBulkOperations, useMemoryEdit } from '@/components/memory/hooks';
import {
  PersonaSidebar,
  MemoryToolbar,
  MemoryNodeItem,
  MemoryPagination,
} from '@/components/memory/components';
import type { PersonaSummary } from '@/server/personas/personaTypes';

const MemoryView: React.FC = () => {
  const { personas, activePersonaId, refreshPersonas } = usePersona();
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | MemoryType>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Debounce query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [typeFilter, pageSize, selectedPersonaId]);

  // Refresh personas on mount
  useEffect(() => {
    void refreshPersonas();
  }, [refreshPersonas]);

  // Auto-select persona
  useEffect(() => {
    if (personas.length === 0) {
      setSelectedPersonaId(null);
      return;
    }
    if (selectedPersonaId && personas.some((p: PersonaSummary) => p.id === selectedPersonaId)) {
      return;
    }
    if (activePersonaId && personas.some((p: PersonaSummary) => p.id === activePersonaId)) {
      setSelectedPersonaId(activePersonaId);
      return;
    }
    setSelectedPersonaId(personas[0].id);
  }, [activePersonaId, personas, selectedPersonaId]);

  // Memory data management
  const { nodes, loading, pagination, errorMessage, setErrorMessage, reloadCurrent } = useMemory({
    selectedPersonaId,
    page,
    pageSize,
    debouncedQuery,
    typeFilter,
  });

  // History management
  const {
    historyById,
    expandedHistoryId,
    historyLoadingId,
    restoringId,
    toggleHistory,
    restoreFromHistory,
    clearHistoryForNode,
    clearAllHistory,
  } = useHistory({
    selectedPersonaId,
    reloadCurrent,
    setErrorMessage,
  });

  // Bulk operations
  const {
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
  } = useBulkOperations({
    nodes,
    selectedPersonaId,
    reloadCurrent,
  });

  // Edit operations
  const {
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
  } = useMemoryEdit({
    selectedPersonaId,
    nodes,
    reloadCurrent,
    setErrorMessage,
  });

  // Clear history when persona changes
  useEffect(() => {
    clearAllHistory();
    setErrorMessage(null);
  }, [selectedPersonaId, clearAllHistory, setErrorMessage]);

  return (
    <div className="animate-in fade-in flex h-full min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/40 duration-300">
      <PersonaSidebar
        personas={personas}
        selectedPersonaId={selectedPersonaId}
        onSelectPersona={setSelectedPersonaId}
        onCancelEdit={cancelEdit}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <MemoryToolbar
          query={query}
          onQueryChange={setQuery}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          selectedPersonaId={selectedPersonaId}
          loading={loading}
          onReload={reloadCurrent}
          onClearAll={() => clearPersonaMemory(clearAllHistory)}
          clearingAll={clearingAll}
          errorMessage={errorMessage}
          selectedIdsCount={selectedIds.length}
          allPageSelected={allPageSelected}
          onToggleSelectPage={toggleSelectPage}
          onClearSelection={clearSelection}
          bulkType={bulkType}
          onBulkTypeChange={setBulkType}
          bulkImportance={bulkImportance}
          onBulkImportanceChange={setBulkImportance}
          bulkBusy={bulkBusy}
          onApplyBulkUpdate={applyBulkUpdate}
          onApplyBulkDelete={applyBulkDelete}
        />

        <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4">
          {!selectedPersonaId && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
              Erstelle zuerst eine Persona oder wähle eine bestehende aus.
            </div>
          )}
          {selectedPersonaId && loading && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
              Memory wird geladen...
            </div>
          )}
          {selectedPersonaId && !loading && nodes.length === 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
              Keine passenden Memory-Einträge.
            </div>
          )}

          {nodes.map((node) => (
            <MemoryNodeItem
              key={node.id}
              node={node}
              isEditing={editingId === node.id}
              draft={draft}
              isSelected={selectedIdSet.has(node.id)}
              isDeleting={deletingId === node.id}
              isSaving={saving}
              expandedHistoryId={expandedHistoryId}
              history={historyById[node.id]}
              isHistoryLoading={historyLoadingId === node.id}
              restoringId={restoringId}
              onToggleSelection={() => toggleNodeSelection(node.id)}
              onToggleHistory={() => toggleHistory(node.id)}
              onBeginEdit={() => beginEdit(node)}
              onDelete={() => deleteNode(node.id, () => clearHistoryForNode(node.id))}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onRestore={(entry) => restoreFromHistory(node, entry)}
              onDraftContentChange={updateDraftContent}
              onDraftTypeChange={updateDraftType}
              onDraftImportanceChange={updateDraftImportance}
            />
          ))}

          {selectedPersonaId && !loading && nodes.length > 0 && (
            <MemoryPagination pagination={pagination} onPageChange={setPage} />
          )}
        </div>
      </section>
    </div>
  );
};

export default MemoryView;
