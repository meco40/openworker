export type ProviderAuthMethod = 'none' | 'api_key' | 'oauth';

export type ProviderEndpointType =
  | 'gemini-native'
  | 'openai-compatible'
  | 'openai_compatible'
  | 'openai-native'
  | 'anthropic-native'
  | 'xai-native'
  | 'mistral-native'
  | 'cohere-native'
  | 'copilot-native'
  | 'github-native';

export type ProviderCapability =
  | 'chat'
  | 'tools'
  | 'vision'
  | 'audio'
  | 'embeddings'
  | 'code_pairing';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  icon: string;
  authMethods: ProviderAuthMethod[];
  endpointType: ProviderEndpointType;
  capabilities: ProviderCapability[];
  defaultModels: string[];
  oauthConfigured?: boolean;
  apiBaseUrl?: string;
  docsUrl?: string;
}

export interface RateLimitWindow {
  window: string;
  limit?: number;
  remaining?: number;
  usedPercent?: number;
  remainingPercent?: number;
  reset?: string;
}

export interface RateLimitSnapshot {
  windows: RateLimitWindow[];
}

export interface FetchedModel {
  id: string;
  name: string;
  provider: string;
  owned_by?: string;
  context_window?: number;
  created?: number;
}
