'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Preset,
  PromptLogEntry,
  PromptLogSummary,
  PromptLogDiagnostics,
  PromptLogsResponse,
  FiltersState,
  UsePromptLogsReturn,
} from '../types';
import { PAGE_SIZE, EMPTY_SUMMARY, EMPTY_DIAGNOSTICS } from '../constants';

interface UsePromptLogsOptions {
  preset: Preset;
  customFrom: string;
  customTo: string;
  reloadKey?: number;
}

export function usePromptLogs({
  preset,
  customFrom,
  customTo,
  reloadKey,
}: UsePromptLogsOptions): UsePromptLogsReturn {
  const [entries, setEntries] = useState<PromptLogEntry[]>([]);
  const [summary, setSummary] = useState<PromptLogSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<FiltersState>({
    search: '',
    risk: 'all',
    provider: 'all',
    model: 'all',
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PromptLogDiagnostics>(EMPTY_DIAGNOSTICS);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const setFilters = useCallback((partial: Partial<FiltersState>) => {
    setFiltersState((prev) => ({ ...prev, ...partial }));
  }, []);

  const updateDistinctValues = useCallback((nextEntries: PromptLogEntry[]) => {
    setProviders((prev) =>
      Array.from(new Set([...prev, ...nextEntries.map((entry) => entry.providerId)])).sort(),
    );
    setModels((prev) =>
      Array.from(new Set([...prev, ...nextEntries.map((entry) => entry.modelName)])).sort(),
    );
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string, append = false) => {
      requestSequenceRef.current += 1;
      const requestSequence = requestSequenceRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const params = new URLSearchParams();
        if (preset === 'custom') {
          if (customFrom) params.set('from', new Date(customFrom).toISOString());
          if (customTo) params.set('to', new Date(customTo).toISOString());
        } else {
          params.set('preset', preset);
        }
        if (filters.search.trim()) params.set('search', filters.search.trim());
        if (filters.risk !== 'all') params.set('risk', filters.risk);
        if (filters.provider !== 'all') params.set('provider', filters.provider);
        if (filters.model !== 'all') params.set('model', filters.model);
        params.set('limit', String(PAGE_SIZE));
        if (cursor) params.set('before', cursor);

        const response = await fetch(`/api/stats/prompt-logs?${params.toString()}`, {
          signal: controller.signal,
        });
        if (requestSequence !== requestSequenceRef.current) return;
        const json = (await response.json()) as PromptLogsResponse;
        if (requestSequence !== requestSequenceRef.current) return;

        if (!json.ok) {
          setError(json.error || 'Failed to load prompt logs.');
          return;
        }

        if (append) {
          setEntries((prev) => [...prev, ...json.entries]);
        } else {
          setEntries(json.entries);
          setSummary(json.summary);
          setTotal(json.total);
          if (json.diagnostics) {
            setDiagnostics(json.diagnostics);
          }
          setExpandedId(null);
        }

        updateDistinctValues(json.entries);
        setHasMore(json.entries.length === PAGE_SIZE);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (requestSequence !== requestSequenceRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load prompt logs.');
      } finally {
        if (requestSequence === requestSequenceRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [customFrom, customTo, filters, preset, updateDistinctValues],
  );

  useEffect(() => {
    void fetchPage(undefined, false);
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchPage, reloadKey]);

  const loadMore = useCallback(() => {
    if (entries.length === 0) return;
    const cursor = entries[entries.length - 1]?.createdAt;
    if (!cursor) return;
    void fetchPage(cursor, true);
  }, [entries, fetchPage]);

  const resetLogs = useCallback(async () => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm('Alle Prompt-Logs und Usage-Statistiken wirklich löschen?');
      if (!confirmed) return;
    }

    setResetting(true);
    setError(null);
    try {
      const response = await fetch('/api/stats/prompt-logs', { method: 'DELETE' });
      const json = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !json.ok) {
        setError(json.error || 'Failed to reset prompt logs.');
        return;
      }
      setEntries([]);
      setSummary(EMPTY_SUMMARY);
      setTotal(0);
      setExpandedId(null);
      setProviders([]);
      setModels([]);
      setDiagnostics(EMPTY_DIAGNOSTICS);
      await fetchPage(undefined, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset prompt logs.');
    } finally {
      setResetting(false);
    }
  }, [fetchPage]);

  return {
    entries,
    summary,
    total,
    loading,
    loadingMore,
    resetting,
    error,
    filters,
    expandedId,
    providers,
    models,
    hasMore,
    diagnostics,
    setFilters,
    setExpandedId,
    fetchPage,
    loadMore,
    resetLogs,
  };
}
