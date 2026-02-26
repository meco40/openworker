import React from 'react';
import type {
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
} from '@/components/model-hub/types';
import PipelineSection from '@/components/model-hub/sections/PipelineSection';

export interface PipelineEditorProps {
  // Pipeline data
  isLoadingPipeline: boolean;
  pipeline: PipelineModel[];
  isLoadingEmbeddingPipeline: boolean;
  embeddingPipeline: PipelineModel[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];

  // Actions
  onOpenAddModelModal: () => void;
  onOpenAddEmbeddingModelModal: () => void;
  onToggleModelStatus: (modelId: string, currentStatus: string) => void;
  onMoveModel: (modelId: string, direction: 'up' | 'down') => void;
  onRemoveModelFromPipeline: (modelId: string) => void;
  onToggleEmbeddingModelStatus: (modelId: string, currentStatus: string) => void;
  onMoveEmbeddingModel: (modelId: string, direction: 'up' | 'down') => void;
  onRemoveEmbeddingModelFromPipeline: (modelId: string) => void;

  // Account management
  isLoadingAccounts: boolean;
  deletingAccountId: string | null;
  onSetDeletingAccountId: (accountId: string | null) => void;
  onDeleteAccount: (accountId: string) => void;

  // Probing
  probeRateLimitsByAccountId?: Record<string, RateLimitSnapshot | null>;
}

export const PipelineEditor: React.FC<PipelineEditorProps> = (props) => {
  // This component wraps the existing PipelineSection for now
  // In a future refactor, the logic from PipelineSection can be moved here
  return <PipelineSection {...props} />;
};

export default PipelineEditor;
