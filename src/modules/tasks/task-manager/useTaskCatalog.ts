import { useCallback, useEffect, useState } from 'react';
import type { Task, TaskStatus } from '@/lib/types';

export function useTaskCatalog(filterStatus: TaskStatus | '') {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, string>>({});

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      const url = `/api/tasks${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to load tasks');
      }
      const data = (await res.json()) as Task[];
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const handleStatusChange = useCallback(
    async (id: string, status: TaskStatus) => {
      setPendingActions((prev) => ({ ...prev, [id]: 'status' }));
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error ?? 'Failed to update task');
        }
        const updated = (await res.json()) as Task;
        setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      } catch {
        void loadTasks();
      } finally {
        setPendingActions((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [loadTasks],
  );

  const handleDelete = useCallback(
    async (id: string, selectedId: string | null, clearSelected: () => void) => {
      if (!confirm('Delete this task? This cannot be undone.')) return;
      setPendingActions((prev) => ({ ...prev, [id]: 'delete' }));
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error ?? 'Failed to delete task');
        }
        setTasks((prev) => prev.filter((t) => t.id !== id));
        if (selectedId === id) clearSelected();
      } catch {
        void loadTasks();
      } finally {
        setPendingActions((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [loadTasks],
  );

  const handleCreated = useCallback((task: Task) => {
    setTasks((prev) => [task, ...prev]);
  }, []);

  return {
    tasks,
    setTasks,
    loading,
    error,
    pendingActions,
    loadTasks,
    handleStatusChange,
    handleDelete,
    handleCreated,
  };
}
