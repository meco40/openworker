// Re-export everything from the modular service directory for backward compatibility
export {
  ModelHubService,
  // Types
  type ConnectProviderAccountInput,
  type EmbeddingInput,
  type DispatchWithFallbackOptions,
  type GeminiEmbeddingModelsApi,
  type OpenAICompatibleEmbeddingResponse,
  type CohereEmbeddingResponse,
  // Utility functions
  asPositiveInteger,
  normalizeBearerSecret,
  extractTextParts,
  tryExtractBatchPayloadAsEmbedContent,
  mapPipelineReasoningEffort,
  EMBEDDING_PROFILE_ID,
  // Embedding functions
  dispatchGeminiEmbedding,
  normalizeOpenAICompatibleEmbeddingInput,
  dispatchOpenAICompatibleEmbedding,
  dispatchCohereEmbedding,
} from './service/index';
