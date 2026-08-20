import { useCallback, useState } from 'react';
import {
  EMBEDDING_PROFILE_ID,
  GRAPHITI_PROFILE_ID,
  PROFILE_ID,
} from '@/components/model-hub/constants';
import type { ApiResponse, PipelineModel } from '@/components/model-hub/types';

export type PipelineMode = 'pipeline' | 'embedding' | 'graphiti';

export interface UsePipelineReturn {
  // Regular pipeline
  pipeline: PipelineModel[];
  isLoadingPipeline: boolean;
  loadPipeline: () => Promise<void>;

  // Embedding pipeline
  embeddingPipeline: PipelineModel[];
  isLoadingEmbeddingPipeline: boolean;
  loadEmbeddingPipeline: () => Promise<void>;

  // Graphiti JSON pipeline
  graphitiPipeline: PipelineModel[];
  isLoadingGraphitiPipeline: boolean;
  loadGraphitiPipeline: () => Promise<void>;

  // Operations
  removeModelFromPipeline: (
    modelId: string,
    mode: PipelineMode,
    onError: (message: string) => void,
  ) => Promise<void>;
  toggleModelStatus: (
    modelId: string,
    currentStatus: string,
    mode: PipelineMode,
    onError: (message: string) => void,
  ) => Promise<void>;
  moveModelInPipeline: (
    modelId: string,
    direction: 'up' | 'down',
    mode: PipelineMode,
    onError: (message: string) => void,
  ) => Promise<void>;
  reloadBoth: () => Promise<void>;
}

export function usePipeline(): UsePipelineReturn {
  const [pipeline, setPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingPipeline, setIsLoadingPipeline] = useState(true);
  const [embeddingPipeline, setEmbeddingPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingEmbeddingPipeline, setIsLoadingEmbeddingPipeline] = useState(true);
  const [graphitiPipeline, setGraphitiPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingGraphitiPipeline, setIsLoadingGraphitiPipeline] = useState(true);

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

  const loadGraphitiPipeline = useCallback(async () => {
    await loadPipelineByProfile(
      GRAPHITI_PROFILE_ID,
      setGraphitiPipeline,
      setIsLoadingGraphitiPipeline,
    );
  }, [loadPipelineByProfile]);

  const loadBothPipelines = useCallback(async () => {
    setIsLoadingPipeline(true);
    setIsLoadingEmbeddingPipeline(true);
    setIsLoadingGraphitiPipeline(true);
    try {
      const response = await fetch(
        '/api/model-hub/pipeline?includeEmbeddings=true&includeGraphiti=true',
      );
      const data = (await response.json()) as ApiResponse & {
        models?: PipelineModel[];
        embeddingModels?: PipelineModel[];
        graphitiModels?: PipelineModel[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPipeline(data.models ?? []);
      setEmbeddingPipeline(data.embeddingModels ?? []);
      setGraphitiPipeline(data.graphitiModels ?? []);
    } catch {
      setPipeline([]);
      setEmbeddingPipeline([]);
      setGraphitiPipeline([]);
    } finally {
      setIsLoadingPipeline(false);
      setIsLoadingEmbeddingPipeline(false);
      setIsLoadingGraphitiPipeline(false);
    }
  }, []);

  const reloadBoth = useCallback(async () => {
    await loadBothPipelines();
  }, [loadBothPipelines]);

  async function removeModelFromPipeline(
    modelId: string,
    mode: PipelineMode = 'pipeline',
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
      } else if (mode === 'graphiti') {
        await loadGraphitiPipeline();
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
    mode: PipelineMode = 'pipeline',
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
      } else if (mode === 'graphiti') {
        await loadGraphitiPipeline();
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
    mode: PipelineMode = 'pipeline',
    onError: (message: string) => void,
  ) {
    try {
      const profileId =
        mode === 'embedding'
          ? EMBEDDING_PROFILE_ID
          : mode === 'graphiti'
            ? GRAPHITI_PROFILE_ID
            : PROFILE_ID;
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', profileId, modelId, direction }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else if (mode === 'graphiti') {
        await loadGraphitiPipeline();
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
    graphitiPipeline,
    isLoadingGraphitiPipeline,
    loadGraphitiPipeline,
    removeModelFromPipeline,
    toggleModelStatus,
    moveModelInPipeline,
    reloadBoth,
  };
}
