import { useCallback, useState } from 'react';
import { EMBEDDING_PROFILE_ID, PROFILE_ID } from '@/components/model-hub/constants';
import type { ApiResponse, PipelineModel } from '@/components/model-hub/types';

export interface UsePipelineReturn {
  // Regular pipeline
  pipeline: PipelineModel[];
  isLoadingPipeline: boolean;
  loadPipeline: () => Promise<void>;

  // Embedding pipeline
  embeddingPipeline: PipelineModel[];
  isLoadingEmbeddingPipeline: boolean;
  loadEmbeddingPipeline: () => Promise<void>;

  // Operations
  removeModelFromPipeline: (
    modelId: string,
    mode: 'pipeline' | 'embedding',
    onError: (message: string) => void,
  ) => Promise<void>;
  toggleModelStatus: (
    modelId: string,
    currentStatus: string,
    mode: 'pipeline' | 'embedding',
    onError: (message: string) => void,
  ) => Promise<void>;
  moveModelInPipeline: (
    modelId: string,
    direction: 'up' | 'down',
    mode: 'pipeline' | 'embedding',
    onError: (message: string) => void,
  ) => Promise<void>;
  reloadBoth: () => Promise<void>;
}

export function usePipeline(): UsePipelineReturn {
  const [pipeline, setPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingPipeline, setIsLoadingPipeline] = useState(true);
  const [embeddingPipeline, setEmbeddingPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingEmbeddingPipeline, setIsLoadingEmbeddingPipeline] = useState(true);

  const loadPipelineByProfile = useCallback(
    async (
      profileId: string,
      setModels: React.Dispatch<React.SetStateAction<PipelineModel[]>>,
      setLoading: React.Dispatch<React.SetStateAction<boolean>>,
    ) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/model-hub/pipeline?profileId=${profileId}`);
        const data = (await response.json()) as ApiResponse & { models?: PipelineModel[] };
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        setModels(data.models ?? []);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadPipeline = useCallback(async () => {
    await loadPipelineByProfile(PROFILE_ID, setPipeline, setIsLoadingPipeline);
  }, [loadPipelineByProfile]);

  const loadEmbeddingPipeline = useCallback(async () => {
    await loadPipelineByProfile(
      EMBEDDING_PROFILE_ID,
      setEmbeddingPipeline,
      setIsLoadingEmbeddingPipeline,
    );
  }, [loadPipelineByProfile]);

  const loadBothPipelines = useCallback(async () => {
    setIsLoadingPipeline(true);
    setIsLoadingEmbeddingPipeline(true);
    try {
      const response = await fetch('/api/model-hub/pipeline?includeEmbeddings=true');
      const data = (await response.json()) as ApiResponse & {
        models?: PipelineModel[];
        embeddingModels?: PipelineModel[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPipeline(data.models ?? []);
      setEmbeddingPipeline(data.embeddingModels ?? []);
    } catch {
      setPipeline([]);
      setEmbeddingPipeline([]);
    } finally {
      setIsLoadingPipeline(false);
      setIsLoadingEmbeddingPipeline(false);
    }
  }, []);

  const reloadBoth = useCallback(async () => {
    await loadBothPipelines();
  }, [loadBothPipelines]);

  async function removeModelFromPipeline(
    modelId: string,
    mode: 'pipeline' | 'embedding' = 'pipeline',
    onError: (message: string) => void,
  ) {
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', modelId }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    }
  }

  async function toggleModelStatus(
    modelId: string,
    currentStatus: string,
    mode: 'pipeline' | 'embedding' = 'pipeline',
    onError: (message: string) => void,
  ) {
    const newStatus = currentStatus === 'active' ? 'offline' : 'active';
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', modelId, status: newStatus }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Status-Update fehlgeschlagen');
    }
  }

  async function moveModelInPipeline(
    modelId: string,
    direction: 'up' | 'down',
    mode: 'pipeline' | 'embedding' = 'pipeline',
    onError: (message: string) => void,
  ) {
    try {
      const profileId = mode === 'embedding' ? EMBEDDING_PROFILE_ID : PROFILE_ID;
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', profileId, modelId, direction }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Reorder fehlgeschlagen');
    }
  }

  return {
    pipeline,
    isLoadingPipeline,
    loadPipeline,
    embeddingPipeline,
    isLoadingEmbeddingPipeline,
    loadEmbeddingPipeline,
    removeModelFromPipeline,
    toggleModelStatus,
    moveModelInPipeline,
    reloadBoth,
  };
}
