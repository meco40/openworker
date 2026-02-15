export interface ProviderCatalogEntry {
  id: string;
  name: string;
  icon: string;
  authMethods: Array<'api_key' | 'oauth'>;
  oauthConfigured?: boolean;
  capabilities: string[];
  defaultModels: string[];
  docsUrl?: string;
  endpointType: string;
}

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  authMethod: 'api_key' | 'oauth';
  secretMasked: string;
  hasRefreshToken: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage?: string | null;
}

export interface PipelineModel {
  id: string;
  profileId: string;
  accountId: string;
  providerId: string;
  modelName: string;
  reasoningEffort?: CodexThinkingLevel;
  priority: number;
  status: 'active' | 'rate-limited' | 'offline';
  createdAt: string;
  updatedAt: string;
}

export type CodexThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface FetchedModel {
  id: string;
  name: string;
  provider: string;
  context_window?: number;
}

export interface ApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ConnectMessage {
  text: string;
  ok: boolean;
}

export interface SessionStats {
  requests: number;
  lastProbeOk: boolean | null;
}
