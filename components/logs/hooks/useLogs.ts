'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGatewayClient } from '../../../src/modules/gateway/ws-client';
import type { LogEntry, LevelFilter } from '../diagnostics';

interface UseLogsOptions {
  levelFilter: LevelFilter;
  sourceFilter: string;
  categoryFilter: string;
  search: string;
}

export function useLogs(options: UseLogsOptions) {
  const { levelFilter, sourceFilter, categoryFilter, search } = options;
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Fetch historical logs
  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (search) params.set('search', search);
      params.set('limit', '500');

      const res = await fetch(`/api/logs?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        setLogs(data.logs);
        setTotalCount(data.total);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [categoryFilter, levelFilter, sourceFilter, search]);

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
          return next.length > 1000 ? next.slice(-1000) : next;
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
  }, []);

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
    isConnected,
    isLoading,
    copiedId,
    fetchLogs,
    handleClear,
    handleExport,
    handleCopyLog,
  };
}
