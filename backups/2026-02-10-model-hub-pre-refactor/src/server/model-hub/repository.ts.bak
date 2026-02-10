import type { EncryptedSecretPayload } from './crypto';

export interface CreateProviderAccountInput {
  providerId: string;
  label: string;
  authMethod: 'api_key' | 'oauth';
  encryptedSecret: EncryptedSecretPayload;
  encryptedRefreshToken: EncryptedSecretPayload | null;
  secretMasked: string;
}

export interface ProviderAccountView {
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
  priority: number;
  status: 'active' | 'rate-limited' | 'offline';
  createdAt: string;
  updatedAt: string;
}

export interface CreatePipelineModelInput {
  profileId: string;
  accountId: string;
  providerId: string;
  modelName: string;
  priority: number;
}

export interface ModelHubRepository {
  createAccount(input: CreateProviderAccountInput): ProviderAccountView;
  listAccounts(): ProviderAccountView[];
  getAccountRecordById(id: string): ProviderAccountRecord | null;
  setHealthStatus(id: string, ok: boolean): void;
  deleteAccount(id: string): boolean;

  // Pipeline persistence
  listPipelineModels(profileId: string): PipelineModelEntry[];
  addPipelineModel(input: CreatePipelineModelInput): PipelineModelEntry;
  removePipelineModel(id: string): boolean;
  updatePipelineModelStatus(id: string, status: 'active' | 'rate-limited' | 'offline'): void;
  updatePipelineModelPriority(id: string, priority: number): void;
  replacePipeline(profileId: string, models: CreatePipelineModelInput[]): PipelineModelEntry[];
}
