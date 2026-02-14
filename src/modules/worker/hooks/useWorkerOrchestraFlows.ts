import { useCallback, useEffect, useState } from 'react';

export interface WorkerOrchestraFlowDraft {
  id: string;
  name: string;
  workspaceType: string;
  graphJson?: string;
  updatedAt: string;
}

export interface WorkerOrchestraFlowPublished {
  id: string;
  name: string;
  workspaceType: string;
  version: number;
  graphJson?: string;
  createdAt: string;
}

export function useWorkerOrchestraFlows() {
  const [drafts, setDrafts] = useState<WorkerOrchestraFlowDraft[]>([]);
  const [published, setPublished] = useState<WorkerOrchestraFlowPublished[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/worker/orchestra/flows');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        drafts?: WorkerOrchestraFlowDraft[];
        published?: WorkerOrchestraFlowPublished[];
      };
      setDrafts(payload.drafts || []);
      setPublished(payload.published || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load orchestra flows';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createDraft = useCallback(
    async (input: { name: string; workspaceType: string; graph: Record<string, unknown> }) => {
      const response = await fetch('/api/worker/orchestra/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // ignore parse failure and keep status-based message
        }
        setError(message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const publishDraft = useCallback(
    async (flowId: string) => {
      const response = await fetch(`/api/worker/orchestra/flows/${flowId}/publish`, {
        method: 'POST',
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // ignore parse failure and keep status-based message
        }
        setError(message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const updateDraft = useCallback(
    async (
      flowId: string,
      updates: { name?: string; workspaceType?: string; graph?: Record<string, unknown> },
    ) => {
      const response = await fetch(`/api/worker/orchestra/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // ignore parse failure and keep status-based message
        }
        setError(message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const deleteDraft = useCallback(
    async (flowId: string) => {
      const response = await fetch(`/api/worker/orchestra/flows/${flowId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // ignore parse failure and keep status-based message
        }
        setError(message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    drafts,
    published,
    loading,
    error,
    refresh,
    createDraft,
    publishDraft,
    updateDraft,
    deleteDraft,
  };
}
