import type { EncryptedSecretPayload } from '@/server/model-hub/crypto';

export interface CreateProviderAccountInput {
  providerId: string;
  label: string;
  authMethod: 'none' | 'api_key' | 'oauth';
  encryptedSecret: EncryptedSecretPayload;
  encryptedRefreshToken: EncryptedSecretPayload | null;
  secretMasked: string;
}

export interface ProviderAccountView {
  id: string;
  providerId: string;
  label: string;
  authMethod: 'none' | 'api_key' | 'oauth';
  secretMasked: string;
  hasRefreshToken: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage?: string | null;
}

export interface ProviderAccountRecord extends ProviderAccountView {
  encryptedSecret: EncryptedSecretPayload;
  encryptedRefreshToken: EncryptedSecretPayload | null;
}

export interface PipelineModelEntry {
  id: string;
  profileId: string;
  accountId: string;
  providerId: string;
  modelName: string;
  reasoningEffort?: PipelineReasoningEffort;
  priority: number;
  status: 'active' | 'rate-limited' | 'offline';
  createdAt: string;
  updatedAt: string;
}

export type PipelineReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CreatePipelineModelInput {
  profileId: string;
  accountId: string;
  providerId: string;
  modelName: string;
  reasoningEffort?: PipelineReasoningEffort;
  priority: number;
}

export interface ModelHubRepository {
  createAccount(input: CreateProviderAccountInput): ProviderAccountView;
  listAccounts(): ProviderAccountView[];
  getAccountRecordById(id: string): ProviderAccountRecord | null;
  updateAccountCredentials(input: {
    id: string;
    encryptedSecret: EncryptedSecretPayload;
    encryptedRefreshToken: EncryptedSecretPayload | null;
    secretMasked: string;
  }): void;
  setHealthStatus(id: string, ok: boolean, message?: string | null): void;
  deleteAccount(id: string): boolean;

  // Pipeline persistence
  listPipelineModels(profileId: string): PipelineModelEntry[];
  addPipelineModel(input: CreatePipelineModelInput): PipelineModelEntry;
  removePipelineModel(id: string): boolean;
  updatePipelineModelStatus(id: string, status: 'active' | 'rate-limited' | 'offline'): void;
  updatePipelineModelPriority(id: string, priority: number): void;
  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[];
}
