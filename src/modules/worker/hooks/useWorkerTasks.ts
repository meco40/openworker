// ─── Worker Tasks Hook ──────────────────────────────────────
// Central hook for all worker task interactions via API.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { WorkerTask, WorkspaceType } from '../../../../types';

export function useWorkerTasks() {
  const [tasks, setTasks] = useState<WorkerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  // ─── Fetch Tasks ──────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/worker');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Create Task ──────────────────────────────────────────
  const createTask = useCallback(
    async (
      objective: string,
      options?: { title?: string; priority?: string; workspaceType?: WorkspaceType },
    ) => {
      try {
        setError(null);
        const res = await fetch('/api/worker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objective,
            title: options?.title,
            priority: options?.priority || 'normal',
            workspaceType: options?.workspaceType,
            conversationId: `web-${Date.now()}`,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.task) {
          setTasks((prev) => [data.task, ...prev]);
        }
        return data.task;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Fehler beim Erstellen');
        return null;
      }
    },
    [],
  );

  // ─── Task Actions ─────────────────────────────────────────
  const performAction = useCallback(
    async (id: string, action: string) => {
      try {
        setError(null);
        const res = await fetch(`/api/worker/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchTasks(); // Refresh after action
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
      }
    },
    [fetchTasks],
  );

  const cancelTask = useCallback((id: string) => performAction(id, 'cancel'), [performAction]);
  const retryTask = useCallback((id: string) => performAction(id, 'retry'), [performAction]);
  const resumeTask = useCallback((id: string) => performAction(id, 'resume'), [performAction]);
  const approveTask = useCallback((id: string) => performAction(id, 'approve'), [performAction]);

  const deleteTask = useCallback(async (id: string) => {
    try {
      setError(null);
      const res = await fetch(`/api/worker/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  }, []);

  // ─── SSE Live Updates ─────────────────────────────────────
  useEffect(() => {
    try {
      const sse = new EventSource('/api/sse');
      sseRef.current = sse;

      sse.addEventListener('worker-status', (event) => {
        try {
          const data = JSON.parse(event.data);
          setTasks((prev) =>
            prev.map((t) => (t.id === data.taskId ? { ...t, status: data.status } : t)),
          );
        } catch {
          /* ignore parse errors */
        }
      });

      sse.onerror = () => {
        // Reconnect after 5 seconds
        setTimeout(() => {
          sseRef.current?.close();
          sseRef.current = null;
        }, 5000);
      };
    } catch {
      // SSE not available
    }

    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return {
    tasks,
    loading,
    error,
    createTask,
    cancelTask,
    retryTask,
    resumeTask,
    approveTask,
    deleteTask,
    refreshTasks: fetchTasks,
  };
}
