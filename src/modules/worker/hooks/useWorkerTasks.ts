// ─── Worker Tasks Hook ──────────────────────────────────────
// Central hook for all worker task interactions via API.

import { useState, useEffect, useCallback } from 'react';
import type { WorkerTask, WorkspaceType } from '../../../../types';
import { WorkerTaskStatus } from '../../../../types';
import { getGatewayClient } from '../../gateway/ws-client';

export function useWorkerTasks() {
  const [tasks, setTasks] = useState<WorkerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // ─── WebSocket Live Updates ────────────────────────────────
  useEffect(() => {
    const client = getGatewayClient();
    client.connect();

    const unsub = client.on('worker.status', (payload) => {
      try {
        const data = payload as { taskId: string; status: string };
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: data.status as WorkerTaskStatus } : t)),
        );
      } catch { /* ignore */ }
    });

    // Also listen for SSE-bridged legacy event name
    const unsubLegacy = client.on('worker-status', (payload) => {
      try {
        const data = payload as { taskId: string; status: string };
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: data.status as WorkerTaskStatus } : t)),
        );
      } catch { /* ignore */ }
    });

    return () => { unsub(); unsubLegacy(); };
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
