'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OpsNodesResponse } from '@/modules/ops/types';

interface ErrorPayload {
  ok?: boolean;
  error?: string;
}

export interface UseOpsNodesResult {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  data: OpsNodesResponse | null;
  pendingAction: string | null;
  mutationError: string | null;
  mutationNotice: string | null;
  refresh: () => Promise<void>;
  actions: {
    approveExecCommand: (command: string) => Promise<void>;
    revokeExecCommand: (command: string) => Promise<void>;
    clearExecApprovals: () => Promise<void>;
    setChannelPersona: (channel: string, personaId: string | null) => Promise<void>;
    connectChannel: (channel: string, token?: string, accountId?: string) => Promise<void>;
    disconnectChannel: (channel: string, accountId?: string) => Promise<void>;
    rotateChannelSecret: (channel: string, accountId?: string) => Promise<void>;
    rejectTelegramPending: () => Promise<void>;
    clearMutationNotice: () => void;
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function readJson(response: Response): Promise<OpsNodesResponse> {
  const payload = (await response.json()) as OpsNodesResponse | ErrorPayload;
  if (!response.ok || payload.ok === false) {
    const errorMessage = 'error' in payload ? payload.error : undefined;
    throw new Error(errorMessage || `HTTP ${response.status}`);
  }
  return payload as OpsNodesResponse;
}

function buildMutationNotice(payload: OpsNodesResponse): string | null {
  const mutation = payload.mutation;
  if (!mutation || typeof mutation.action !== 'string') return null;

  if (mutation.action === 'exec.approve') return 'Exec command approved.';
  if (mutation.action === 'exec.revoke') return 'Exec command revoked.';
  if (mutation.action === 'exec.clear') return 'Exec approvals cleared.';
  if (mutation.action === 'bindings.setPersona') return 'Channel persona binding updated.';
  if (mutation.action === 'channels.connect') return 'Channel connection updated.';
  if (mutation.action === 'channels.disconnect') return 'Channel disconnected.';
  if (mutation.action === 'channels.rotateSecret') return 'Bridge webhook secret rotated.';
  if (mutation.action === 'telegram.rejectPending')
    return 'Pending Telegram pairing request rejected.';
  return 'Nodes action applied.';
}

export function useOpsNodes(): UseOpsNodesResult {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OpsNodesResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (loading) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const response = await fetch('/api/ops/nodes', { cache: 'no-store' });
      const payload = await readJson(response);
      setData(payload);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Failed to load node diagnostics.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loading]);

  const runMutation = useCallback(async (payload: Record<string, unknown>) => {
    const action = typeof payload.action === 'string' ? payload.action : 'nodes.action';
    setPendingAction(action);
    setMutationError(null);
    setMutationNotice(null);

    try {
      const response = await fetch('/api/ops/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      setData(body);
      setMutationNotice(buildMutationNotice(body));
    } catch (mutationRequestError) {
      setMutationError(getErrorMessage(mutationRequestError, 'Failed to apply nodes action.'));
    } finally {
      setPendingAction(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    refreshing,
    error,
    data,
    pendingAction,
    mutationError,
    mutationNotice,
    refresh,
    actions: {
      approveExecCommand: async (command: string) => {
        const trimmed = command.trim();
        if (!trimmed) {
          setMutationError('Command is required.');
          return;
        }
        await runMutation({ action: 'exec.approve', command: trimmed });
      },
      revokeExecCommand: async (command: string) => {
        const trimmed = command.trim();
        if (!trimmed) {
          setMutationError('Command is required.');
          return;
        }
        await runMutation({ action: 'exec.revoke', command: trimmed });
      },
      clearExecApprovals: async () => {
        await runMutation({ action: 'exec.clear' });
      },
      setChannelPersona: async (channel: string, personaId: string | null) => {
        await runMutation({ action: 'bindings.setPersona', channel, personaId });
      },
      connectChannel: async (channel: string, token?: string, accountId?: string) => {
        await runMutation({ action: 'channels.connect', channel, token, accountId });
      },
      disconnectChannel: async (channel: string, accountId?: string) => {
        await runMutation({ action: 'channels.disconnect', channel, accountId });
      },
      rotateChannelSecret: async (channel: string, accountId?: string) => {
        await runMutation({ action: 'channels.rotateSecret', channel, accountId });
      },
      rejectTelegramPending: async () => {
        await runMutation({ action: 'telegram.rejectPending' });
      },
      clearMutationNotice: () => {
        setMutationNotice(null);
      },
    },
  };
}
