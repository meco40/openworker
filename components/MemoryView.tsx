'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MemoryNode, MemoryType } from '../core/memory/types';
import { usePersona } from '../src/modules/personas/PersonaContext';

const MEMORY_TYPES: MemoryType[] = [
  'fact',
  'preference',
  'avoidance',
  'lesson',
  'personality_trait',
  'workflow_pattern',
];

const TYPE_LABEL: Record<MemoryType, string> = {
  fact: 'Fakt',
  preference: 'Präferenz',
  avoidance: 'Vermeidung',
  lesson: 'Lektion',
  personality_trait: 'Eigenschaft',
  workflow_pattern: 'Workflow',
};

interface EditDraft {
  content: string;
  type: MemoryType;
  importance: number;
}

interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface MemoryHistoryEntry {
  index: number;
  action: string;
  timestamp: string;
  content?: string;
  type?: MemoryType;
  importance?: number;
  version?: number;
}

interface MemoryHistoryResponse {
  ok?: boolean;
  node?: MemoryNode;
  history?: MemoryHistoryEntry[];
  error?: string;
}

const MemoryView: React.FC = () => {
  const { personas, activePersonaId, refreshPersonas } = usePersona();
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | MemoryType>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkType, setBulkType] = useState<'keep' | MemoryType>('keep');
  const [bulkImportance, setBulkImportance] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [historyById, setHistoryById] = useState<Record<string, MemoryHistoryEntry[]>>({});
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadMemory = useCallback(
    async (
      personaId: string,
      options?: {
        page?: number;
        pageSize?: number;
        query?: string;
        type?: 'all' | MemoryType;
      },
    ) => {
      const pageToLoad = options?.page ?? page;
      const pageSizeToLoad = options?.pageSize ?? pageSize;
      const queryToLoad = options?.query ?? debouncedQuery;
      const typeToLoad = options?.type ?? typeFilter;

      const params = new URLSearchParams({
        personaId,
        page: String(pageToLoad),
        pageSize: String(pageSizeToLoad),
      });
      if (queryToLoad.trim()) {
        params.set('query', queryToLoad.trim());
      }
      if (typeToLoad !== 'all') {
        params.set('type', typeToLoad);
      }

      setLoading(true);
      try {
        const response = await fetch(`/api/memory?${params.toString()}`, {
          cache: 'no-store',
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          nodes?: MemoryNode[];
          pagination?: PaginationState;
        };
        if (response.ok && payload.ok && Array.isArray(payload.nodes)) {
          setErrorMessage(null);
          setNodes(payload.nodes);
          setPagination(
            payload.pagination ?? {
              page: pageToLoad,
              pageSize: pageSizeToLoad,
              total: payload.nodes.length,
              totalPages: 1,
            },
          );
          setSelectedIds((previous) =>
            previous.filter((id) => payload.nodes?.some((node) => node.id === id)),
          );
        } else {
          setErrorMessage(
            String((payload as { error?: string }).error || 'Memory konnte nicht geladen werden.'),
          );
          setNodes([]);
          setPagination((previous) => ({ ...previous, total: 0, totalPages: 1 }));
          setSelectedIds([]);
        }
      } catch {
        setErrorMessage('Memory konnte nicht geladen werden.');
        setNodes([]);
        setPagination((previous) => ({ ...previous, total: 0, totalPages: 1 }));
        setSelectedIds([]);
      } finally {
        setLoading(false);
      }
    },
    [debouncedQuery, page, pageSize, typeFilter],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [typeFilter, pageSize, selectedPersonaId]);

  useEffect(() => {
    setHistoryById({});
    setExpandedHistoryId(null);
    setErrorMessage(null);
  }, [selectedPersonaId]);

  useEffect(() => {
    if (!selectedPersonaId) return;
    void loadMemory(selectedPersonaId, { page, pageSize, query: debouncedQuery, type: typeFilter });
  }, [debouncedQuery, loadMemory, page, pageSize, selectedPersonaId, typeFilter]);

  const reloadCurrent = useCallback(async () => {
    if (!selectedPersonaId) return;
    await loadMemory(selectedPersonaId, {
      page,
      pageSize,
      query: debouncedQuery,
      type: typeFilter,
    });
  }, [debouncedQuery, loadMemory, page, pageSize, selectedPersonaId, typeFilter]);

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
    [selectedPersonaId],
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
    [loadHistory, reloadCurrent, selectedPersonaId],
  );

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
    if (!window.confirm(`Ausgewählte ${selectedIds.length} Memory-Einträge löschen?`)) return;
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
  }, [reloadCurrent, selectedIds, selectedPersonaId]);

  useEffect(() => {
    void refreshPersonas();
  }, [refreshPersonas]);

  useEffect(() => {
    if (personas.length === 0) {
      setSelectedPersonaId(null);
      setNodes([]);
      return;
    }
    if (selectedPersonaId && personas.some((persona) => persona.id === selectedPersonaId)) {
      return;
    }
    if (activePersonaId && personas.some((persona) => persona.id === activePersonaId)) {
      setSelectedPersonaId(activePersonaId);
      return;
    }
    setSelectedPersonaId(personas[0].id);
  }, [activePersonaId, personas, selectedPersonaId]);

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
  }, [cancelEdit, draft, editingId, nodes, reloadCurrent, selectedPersonaId]);

  const deleteNode = useCallback(
    async (nodeId: string) => {
      if (!selectedPersonaId) return;
      if (!window.confirm('Diese Memory wirklich löschen?')) return;
      setDeletingId(nodeId);
      try {
        const response = await fetch(
          `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}&id=${encodeURIComponent(nodeId)}`,
          { method: 'DELETE' },
        );
        if (response.ok) {
          setHistoryById((previous) => {
            const next = { ...previous };
            delete next[nodeId];
            return next;
          });
          if (expandedHistoryId === nodeId) {
            setExpandedHistoryId(null);
          }
          await reloadCurrent();
        }
      } finally {
        setDeletingId(null);
      }
    },
    [expandedHistoryId, reloadCurrent, selectedPersonaId],
  );

  const clearPersonaMemory = useCallback(async () => {
    if (!selectedPersonaId) return;
    if (!window.confirm('Alle Memory-Einträge dieser Persona löschen?')) return;
    setClearingAll(true);
    try {
      const response = await fetch(
        `/api/memory?personaId=${encodeURIComponent(selectedPersonaId)}`,
        { method: 'DELETE' },
      );
      if (response.ok) {
        setHistoryById({});
        setExpandedHistoryId(null);
        await reloadCurrent();
        cancelEdit();
      }
    } finally {
      setClearingAll(false);
    }
  }, [cancelEdit, reloadCurrent, selectedPersonaId]);

  const selectedPersona = selectedPersonaId
    ? personas.find((persona) => persona.id === selectedPersonaId) || null
    : null;

  return (
    <div className="animate-in fade-in flex h-full min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/40 duration-300">
      <aside className="w-80 border-r border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-4">
          <h2 className="text-sm font-black tracking-widest text-white uppercase">Personas</h2>
          <p className="mt-1 text-xs text-zinc-500">Wähle eine Persona, um Memory zu verwalten.</p>
        </div>
        <div className="space-y-2">
          {personas.map((persona) => (
            <button
              key={persona.id}
              onClick={() => {
                setSelectedPersonaId(persona.id);
                cancelEdit();
              }}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                selectedPersonaId === persona.id
                  ? 'border-indigo-500/50 bg-indigo-500/10 text-white'
                  : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700'
              }`}
            >
              <span className="truncate text-sm">
                {persona.emoji} {persona.name}
              </span>
            </button>
          ))}
          {personas.length === 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
              Keine Personas vorhanden.
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-zinc-800 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-black tracking-widest text-white uppercase">Memory</h3>
              <div className="text-xs text-zinc-500">
                {selectedPersona
                  ? `${selectedPersona.emoji} ${selectedPersona.name}`
                  : 'Keine Persona gewählt'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void reloadCurrent()}
                disabled={!selectedPersonaId || loading}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Neu laden
              </button>
              <button
                onClick={() => void clearPersonaMemory()}
                disabled={!selectedPersonaId || clearingAll}
                className="rounded-md border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
              >
                Alle löschen
              </button>
            </div>
          </div>

          {errorMessage && (
            <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {errorMessage}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Suche nach Inhalt oder Typ..."
              className="min-w-[260px] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            />
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as 'all' | MemoryType)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            >
              <option value="all">Alle Typen</option>
              {MEMORY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </select>
            <select
              value={String(pageSize)}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            >
              <option value="25">25 / Seite</option>
              <option value="50">50 / Seite</option>
              <option value="100">100 / Seite</option>
              <option value="200">200 / Seite</option>
            </select>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectPage}
                disabled={nodes.length === 0}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                {allPageSelected ? 'Seite abwählen' : 'Seite auswählen'}
              </button>
              <button
                onClick={() => setSelectedIds([])}
                disabled={selectedIds.length === 0}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Auswahl löschen
              </button>
              <span className="text-xs text-zinc-500">{selectedIds.length} ausgewählt</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={bulkType}
                onChange={(event) => setBulkType(event.target.value as 'keep' | MemoryType)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
              >
                <option value="keep">Typ unverändert</option>
                {MEMORY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={5}
                value={bulkImportance}
                onChange={(event) => setBulkImportance(event.target.value)}
                placeholder="Importance"
                className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => void applyBulkUpdate()}
                disabled={selectedIds.length === 0 || bulkBusy}
                className="rounded border border-emerald-800/70 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-40"
              >
                Bulk speichern
              </button>
              <button
                onClick={() => void applyBulkDelete()}
                disabled={selectedIds.length === 0 || bulkBusy}
                className="rounded border border-red-900/70 px-2 py-1 text-xs text-red-300 hover:bg-red-950/30 disabled:opacity-40"
              >
                Bulk löschen
              </button>
            </div>
          </div>
        </header>

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

          {nodes.map((node) => {
            const isEditing = editingId === node.id && draft !== null;
            return (
              <article
                key={node.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIdSet.has(node.id)}
                      onChange={() => toggleNodeSelection(node.id)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
                    />
                    <span className="rounded border border-indigo-600/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-indigo-300 uppercase">
                      {TYPE_LABEL[node.type]}
                    </span>
                    <span className="text-[11px] text-zinc-500">
                      Importance: {node.importance}/5
                    </span>
                    <span className="text-[11px] text-zinc-500">
                      Version: {Number(node.metadata?.version || 1)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void toggleHistory(node.id)}
                      disabled={historyLoadingId === node.id}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {expandedHistoryId === node.id ? 'Verlauf ausblenden' : 'Verlauf'}
                    </button>
                    {!isEditing ? (
                      <>
                        <button
                          onClick={() => beginEdit(node)}
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Bearbeiten
                        </button>
                        <button
                          onClick={() => void deleteNode(node.id)}
                          disabled={deletingId === node.id}
                          className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/30 disabled:opacity-40"
                        >
                          Löschen
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => void saveEdit()}
                          disabled={saving}
                          className="rounded border border-emerald-800/70 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-40"
                        >
                          Speichern
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={saving}
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                        >
                          Abbrechen
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {!isEditing ? (
                  <div className="space-y-2">
                    <p className="text-sm leading-relaxed text-zinc-200">{node.content}</p>
                    <div className="text-[11px] text-zinc-500">
                      {node.timestamp} · v{Number(node.metadata?.version || 1)}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={draft.content}
                      onChange={(event) =>
                        setDraft((prev) => (prev ? { ...prev, content: event.target.value } : prev))
                      }
                      className="min-h-[90px] w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
                    />
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={draft.type}
                        onChange={(event) =>
                          setDraft((prev) =>
                            prev ? { ...prev, type: event.target.value as MemoryType } : prev,
                          )
                        }
                        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-indigo-500"
                      >
                        {MEMORY_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {TYPE_LABEL[type]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={draft.importance}
                        onChange={(event) =>
                          setDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  importance: Math.min(
                                    5,
                                    Math.max(1, Number(event.target.value || 1)),
                                  ),
                                }
                              : prev,
                          )
                        }
                        className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                )}

                {expandedHistoryId === node.id && (
                  <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
                      Verlauf
                    </div>
                    {historyLoadingId === node.id && (
                      <div className="text-xs text-zinc-500">History wird geladen...</div>
                    )}
                    {historyLoadingId !== node.id &&
                      (!historyById[node.id] || historyById[node.id].length === 0) && (
                        <div className="text-xs text-zinc-500">
                          Keine History-Einträge vorhanden.
                        </div>
                      )}
                    {historyLoadingId !== node.id &&
                      (historyById[node.id] || []).map((entry) => (
                        <div
                          key={`${node.id}:${entry.index}:${entry.timestamp}`}
                          className="mb-2 rounded border border-zinc-800 bg-zinc-900/40 p-2 last:mb-0"
                        >
                          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[11px] text-zinc-400">
                              {entry.action} · {entry.timestamp} · v{Number(entry.version || 1)}
                            </div>
                            <button
                              onClick={() => void restoreFromHistory(node, entry)}
                              disabled={
                                restoringId === node.id || !String(entry.content || '').trim()
                              }
                              className="rounded border border-amber-800/70 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-950/30 disabled:opacity-40"
                            >
                              Wiederherstellen
                            </button>
                          </div>
                          <div className="text-xs leading-relaxed text-zinc-300">
                            {String(entry.content || '').trim() || '(Kein Inhalt)'}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </article>
            );
          })}

          {selectedPersonaId && !loading && nodes.length > 0 && (
            <div className="mt-4 flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <span className="text-xs text-zinc-500">
                Seite {pagination.page} / {pagination.totalPages} - {pagination.total} Einträge
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((previous) => Math.max(1, previous - 1))}
                  disabled={pagination.page <= 1}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Zurück
                </button>
                <button
                  onClick={() =>
                    setPage((previous) => Math.min(pagination.totalPages, previous + 1))
                  }
                  disabled={pagination.page >= pagination.totalPages}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Weiter
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default MemoryView;
