import type { MasterRepository } from '@/server/master/repository';
import type { MasterCapabilityScore, WorkspaceScope } from '@/server/master/types';

const DEFAULT_CAPABILITIES = [
  'web_search',
  'code_generation',
  'notes',
  'reminders',
  'cron',
  'system_ops',
  'gmail',
  'toolforge',
];

export function buildCapabilityInventory(
  repo: MasterRepository,
  scope: WorkspaceScope,
): MasterCapabilityScore[] {
  const existing = repo.listCapabilityScores(scope);
  const existingKeys = new Set(existing.map((entry) => entry.capability));
  for (const capability of DEFAULT_CAPABILITIES) {
    if (existingKeys.has(capability)) continue;
    repo.upsertCapabilityScore(scope, capability, 0.5, '{"source":"bootstrap"}', null);
  }
  return repo.listCapabilityScores(scope);
}
