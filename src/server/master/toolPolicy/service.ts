import type { MasterRepository } from '@/server/master/repository';
import type { MasterToolPolicy, WorkspaceScope } from '@/server/master/types';

export function loadToolPolicy(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  fallbackAllowlist?: string[];
}): MasterToolPolicy | null {
  const existing = input.repo.getToolPolicy(input.scope);
  if (existing) {
    return existing;
  }
  if (!input.fallbackAllowlist) {
    return null;
  }
  return {
    id: 'default',
    userId: input.scope.userId,
    workspaceId: input.scope.workspaceId,
    security: 'allowlist',
    ask: 'on_miss',
    allowlist: input.fallbackAllowlist,
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
  };
}

export function saveToolPolicy(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  policy: Omit<MasterToolPolicy, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>;
}): MasterToolPolicy {
  return input.repo.upsertToolPolicy(input.scope, input.policy);
}
