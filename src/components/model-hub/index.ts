// Model Hub Module - Main Entry Point
// Re-exports all types, hooks, and components for the model hub

// Types (from existing types.ts)
export type {
  ApiResponse,
  ConnectMessage,
  CodexThinkingLevel,
  FetchedModel,
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
  RateLimitWindow,
  SessionStats,
} from './types';

// Constants
export { CAPABILITY_LABELS, PROFILE_ID, EMBEDDING_PROFILE_ID } from './constants';

// Utils
export { filterLiveModels, getDefaultActiveModel } from './utils';

// Hooks
export { useModelHub, usePipeline, useProviders } from './hooks';
export type { UseModelHubReturn, UsePipelineReturn, UseProvidersReturn } from './hooks';

// Components
export {
  AddProviderModal,
  ModelSelector,
  PipelineEditor,
  ProviderCard,
  ProviderList,
} from './components';
export type {
  AddProviderModalProps,
  ModelSelectorProps,
  PipelineEditorProps,
  ProviderCardProps,
  ProviderListProps,
} from './components';

// Default export - ModelHub component
export { default } from './ModelHub';
export { default as ModelHub } from './ModelHub';
