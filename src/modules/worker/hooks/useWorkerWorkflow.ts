import { useCallback, useEffect, useState } from 'react';
import { getGatewayClient } from '../../gateway/ws-client';

export interface WorkerWorkflowNode {
  id: string;
  personaId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

export interface WorkerWorkflowState {
  taskId: string;
  runId: string | null;
  flowPublishedId: string | null;
  nodes: WorkerWorkflowNode[];
  edges: Array<{ from: string; to: string }>;
  activePath: string[];
  currentNodeId: string | null;
  timestamp: string;
}

export function useWorkerWorkflow(taskId: string) {
  const [workflow, setWorkflow] = useState<WorkerWorkflowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const normalizeWorkflow = useCallback((input: WorkerWorkflowState | null): WorkerWorkflowState | null => {
    if (!input) return null;
    return {
      ...input,
      nodes: input.nodes.map((node) => ({
        ...node,
        status: node.status || 'pending',
      })),
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`/api/worker/${taskId}/workflow`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { workflow?: WorkerWorkflowState };
      setWorkflow(normalizeWorkflow(payload.workflow || null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workflow');
    } finally {
      setLoading(false);
    }
  }, [taskId, normalizeWorkflow]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const client = getGatewayClient();
    client.connect();
    const unsubscribe = client.on('worker.workflow', (payload) => {
      const data = payload as WorkerWorkflowState;
      if (data.taskId === taskId) {
        setWorkflow(normalizeWorkflow(data));
      }
    });

    return () => {
      unsubscribe();
    };
  }, [taskId, normalizeWorkflow]);

  return {
    workflow,
    loading,
    error,
    refresh,
  };
}
