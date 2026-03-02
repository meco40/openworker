'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getGatewayClient } from '@/modules/gateway/ws-client';
import type { LogEntry, LevelFilter } from '@/components/logs/diagnostics';

interface UseLogsOptions {
  levelFilter: LevelFilter;
  sourceFilter: string;
  categoryFilter: string;
  search: string;
  historyLimit: number;
  streamBufferLimit: number;
}

export function useLogs(options: UseLogsOptions) {
  const { levelFilter, sourceFilter, categoryFilter, search, historyLimit, streamBufferLimit } = options;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const safeHistoryLimit = Number.isFinite(historyLimit)
    ? Math.min(1000, Math.max(1, Math.floor(historyLimit)))
    : 500;
  const safeStreamBufferLimit = Number.isFinite(streamBufferLimit)
    ? Math.min(5000, Math.max(100, Math.floor(streamBufferLimit)))
    : 1000;

  function resolveFallbackCursor(entries: LogEntry[]): string | null {
    return entries.length > 0 ? entries[0]?.createdAt ?? null : null;
  }

  function mergeUniqueLogs(older: LogEntry[], existing: LogEntry[]): LogEntry[] {
    const next: LogEntry[] = [];
    const seenIds = new Set<string>();
    for (const entry of [...older, ...existing]) {
      if (seenIds.has(entry.id)) {
        continue;
      }
      seenIds.add(entry.id);
      next.push(entry);
    }
    return next;
  }

  interface LogsResponsePayload {
    ok?: boolean;
    logs?: LogEntry[];
    total?: number;
    page?: {
      limit?: number;
      before?: string | null;
      returned?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
    };
  }

  // Fetch historical logs
  const fetchLogs = useCallback(async () => {
    requestSequenceRef.current += 1;
    const requestSequence = requestSequenceRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (search) params.set('search', search);
      params.set('limit', String(safeHistoryLimit));

      const res = await fetch(`/api/logs?${params.toString()}`, { signal: controller.signal });
      if (requestSequence !== requestSequenceRef.current) return;
      const data = (await res.json()) as LogsResponsePayload;
      if (requestSequence !== requestSequenceRef.current) return;
      if (data.ok) {
        const nextLogs = Array.isArray(data.logs) ? data.logs : [];
        setLogs(nextLogs);
        setTotalCount(typeof data.total === 'number' ? data.total : nextLogs.length);
        setHasMoreHistory(Boolean(data.page?.hasMore));
        setHistoryCursor(data.page?.nextCursor ?? resolveFallbackCursor(nextLogs));
      }
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
      // Silently fail
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }, [categoryFilter, levelFilter, safeHistoryLimit, search, sourceFilter]);

  const loadOlder = useCallback(async () => {
    if (!historyCursor || !hasMoreHistory || isLoadingMore) {
      return;
    }

    requestSequenceRef.current += 1;
    const requestSequence = requestSequenceRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoadingMore(true);
    // If pagination interrupts an in-flight full reload, clear the blocking loading state.
    setIsLoading(false);
    try {
      const params = new URLSearchParams();
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (search) params.set('search', search);
      params.set('limit', String(safeHistoryLimit));
      params.set('before', historyCursor);

      const res = await fetch(`/api/logs?${params.toString()}`, { signal: controller.signal });
      if (requestSequence !== requestSequenceRef.current) return;
      const data = (await res.json()) as LogsResponsePayload;
      if (requestSequence !== requestSequenceRef.current) return;
      if (data.ok) {
        const olderLogs = Array.isArray(data.logs) ? data.logs : [];
        setLogs((previous) => {
          const merged = mergeUniqueLogs(olderLogs, previous);
          return merged.length > safeStreamBufferLimit
            ? merged.slice(-safeStreamBufferLimit)
            : merged;
        });
        setHasMoreHistory(Boolean(data.page?.hasMore));
        setHistoryCursor(data.page?.nextCursor ?? resolveFallbackCursor(olderLogs));
        if (typeof data.total === 'number') {
          setTotalCount(data.total);
        }
      }
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
      // Silently fail
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [
    categoryFilter,
    hasMoreHistory,
    historyCursor,
    isLoadingMore,
    levelFilter,
    safeHistoryLimit,
    safeStreamBufferLimit,
    search,
    sourceFilter,
  ]);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?sources=1');
      const data = await res.json();
      if (data.ok) setSources(data.sources);
    } catch {
      // Silently fail
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?categories=1');
      const data = await res.json();
      if (data.ok) setCategories(data.categories);
    } catch {
      // Silently fail
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    void fetchSources();
  }, [fetchSources]);

  useEffect(() => {
    void fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // WebSocket real-time stream
  useEffect(() => {
    const client = getGatewayClient();
    client.connect();

    // Subscribe to log events on the server
    client.request('logs.subscribe', {}).catch(() => {});

    const unsubState = client.onStateChange((state) => {
      setIsConnected(state === 'connected');
    });

    const unsub = client.on('log.entry', (payload) => {
      try {
        const entry = payload as LogEntry;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > safeStreamBufferLimit
            ? next.slice(-safeStreamBufferLimit)
            : next;
        });
        setTotalCount((c) => c + 1);

        setSources((prev) => {
          if (!prev.includes(entry.source)) {
            return [...prev, entry.source].sort();
          }
          return prev;
        });

        setCategories((prev) => {
          if (!prev.includes(entry.category)) {
            return [...prev, entry.category].sort();
          }
          return prev;
        });
      } catch {
        /* Invalid event data */
      }
    });

    // Set connected if already connected
    if (client.state === 'connected') setIsConnected(true);

    return () => {
      unsub();
      unsubState();
      client.request('logs.unsubscribe', {}).catch(() => {});
      setIsConnected(false);
    };
  }, [safeStreamBufferLimit]);

  // Filtered logs
  const filteredLogs = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (sourceFilter !== 'all' && l.source !== sourceFilter) return false;
    if (categoryFilter !== 'all' && l.category !== categoryFilter) return false;
    if (search && !l.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Actions
  const handleClear = useCallback(async () => {
    try {
      await fetch('/api/logs', { method: 'DELETE' });
      setLogs([]);
      setTotalCount(0);
      setHasMoreHistory(false);
      setHistoryCursor(null);
    } catch {
      // Silently fail
    }
  }, []);

  const handleExport = useCallback(() => {
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  const handleCopyLog = useCallback((log: LogEntry) => {
    const text = `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.source}: ${log.message}`;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(log.id);
        setTimeout(() => setCopiedId(null), 1500);
      })
      .catch((error: unknown) => {
        console.warn('Failed to copy log entry:', error);
      });
  }, []);

  return {
    logs,
    filteredLogs,
    sources,
    categories,
    totalCount,
    hasMoreHistory,
    isLoadingMore,
    isConnected,
    isLoading,
    copiedId,
    fetchLogs,
    loadOlder,
    handleClear,
    handleExport,
    handleCopyLog,
  };
}
