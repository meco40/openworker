'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeGraphApiPayload } from '@/components/knowledge/graph/types';

interface UseKnowledgeGraphResult {
  payload: KnowledgeGraphApiPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useKnowledgeGraph(selectedPersonaId: string | null): UseKnowledgeGraphResult {
  const [payload, setPayload] = useState<KnowledgeGraphApiPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const load = useCallback(async () => {
    requestSequenceRef.current += 1;
    const requestSequence = requestSequenceRef.current;
    abortRef.current?.abort();

    if (!selectedPersonaId) {
      setLoading(false);
      setPayload(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        personaId: selectedPersonaId,
        limit: '500',
        edgeLimit: '3000',
      });
      const response = await fetch(`/api/knowledge/graph?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (requestSequence !== requestSequenceRef.current) return;
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        graph?: KnowledgeGraphApiPayload['graph'];
        stats?: KnowledgeGraphApiPayload['stats'];
      };
      if (requestSequence !== requestSequenceRef.current) return;
      if (!response.ok || !data.ok || !data.graph || !data.stats) {
        setPayload(null);
        setError(String(data.error || 'Knowledge Graph konnte nicht geladen werden.'));
        return;
      }
      setPayload({
        graph: data.graph,
        stats: data.stats,
      });
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
      if (requestSequence !== requestSequenceRef.current) return;
      setPayload(null);
      setError('Knowledge Graph konnte nicht geladen werden.');
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [selectedPersonaId]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  return {
    payload,
    loading,
    error,
    reload: load,
  };
}
