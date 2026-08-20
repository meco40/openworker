import type {
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
} from '@/components/model-hub/types';

export interface PipelineSectionProps {
  isLoadingPipeline: boolean;
  pipeline: PipelineModel[];
  isLoadingEmbeddingPipeline: boolean;
  embeddingPipeline: PipelineModel[];
  isLoadingGraphitiPipeline?: boolean;
  graphitiPipeline?: PipelineModel[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  onOpenAddModelModal: () => void;
  onOpenAddEmbeddingModelModal: () => void;
  onOpenAddGraphitiModelModal?: () => void;
  onToggleModelStatus: (modelId: string, currentStatus: string) => void;
  onMoveModel: (modelId: string, direction: 'up' | 'down') => void;
  onRemoveModelFromPipeline: (modelId: string) => void;
  onToggleEmbeddingModelStatus: (modelId: string, currentStatus: string) => void;
  onMoveEmbeddingModel: (modelId: string, direction: 'up' | 'down') => void;
  onRemoveEmbeddingModelFromPipeline: (modelId: string) => void;
  onToggleGraphitiModelStatus?: (modelId: string, currentStatus: string) => void;
  onMoveGraphitiModel?: (modelId: string, direction: 'up' | 'down') => void;
  onRemoveGraphitiModelFromPipeline?: (modelId: string) => void;
  isLoadingAccounts: boolean;
  deletingAccountId: string | null;
  onSetDeletingAccountId: (accountId: string | null) => void;
  onDeleteAccount: (accountId: string) => void;
  probeRateLimitsByAccountId?: Record<string, RateLimitSnapshot | null>;
}

export interface PipelineCardsProps {
  isLoading: boolean;
  models: PipelineModel[];
  showPrimaryBadge: boolean;
  emptyTitle: string;
  emptyDescription: string;
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  onToggleStatus: (modelId: string, currentStatus: string) => void;
  onMove: (modelId: string, direction: 'up' | 'down') => void;
  onRemove: (modelId: string) => void;
  probeRateLimitsByAccountId?: Record<string, RateLimitSnapshot | null>;
}

export interface ProviderAccountsPanelProps {
  providerAccounts: ProviderAccount[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  pipeline: PipelineModel[];
  additionalPipelines?: PipelineModel[][];
  isLoadingAccounts: boolean;
  deletingAccountId: string | null;
  onSetDeletingAccountId: (accountId: string | null) => void;
  onDeleteAccount: (accountId: string) => void;
}
