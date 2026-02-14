import { CORE_MEMORY_TOOLS } from './gemini';
import type { MemoryNode } from './types';

export { CORE_MEMORY_TOOLS };

interface MemoryCallResponse {
  ok: boolean;
  result?: { action: 'store' | 'recall'; data: unknown };
  error?: string;
}

interface MemorySnapshotResponse {
  ok: boolean;
  nodes?: MemoryNode[];
  error?: string;
}

export const handleCoreMemoryCall = async (
  fcName: string,
  args: unknown,
  personaId?: string | null,
): Promise<{ action: 'store' | 'recall'; data: unknown } | null> => {
  if (fcName !== 'core_memory_store' && fcName !== 'core_memory_recall') return null;
  if (!personaId) {
    console.warn('Memory call skipped: personaId is required.');
    return null;
  }

  const payloadArgs =
    args && typeof args === 'object'
      ? { ...(args as Record<string, unknown>), personaId }
      : { personaId };

  try {
    const response = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcName, args: payloadArgs }),
    });

    const payload = (await response.json()) as MemoryCallResponse;
    if (!response.ok || !payload.ok || !payload.result) {
      console.warn('Memory call failed:', payload.error || `HTTP ${response.status}`);
      return null;
    }

    return payload.result;
  } catch (error) {
    console.warn('Memory call request failed:', error);
    return null;
  }
};

export const getMemorySnapshot = async (personaId?: string | null): Promise<MemoryNode[]> => {
  if (!personaId) {
    return [];
  }

  try {
    const response = await fetch(`/api/memory?personaId=${encodeURIComponent(personaId)}`, {
      method: 'GET',
    });
    const payload = (await response.json()) as MemorySnapshotResponse;
    if (!response.ok || !payload.ok || !Array.isArray(payload.nodes)) {
      console.warn('Memory snapshot failed:', payload.error || `HTTP ${response.status}`);
      return [];
    }
    return payload.nodes;
  } catch (error) {
    console.warn('Memory snapshot request failed:', error);
    return [];
  }
};
