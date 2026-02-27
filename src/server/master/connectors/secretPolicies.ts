import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { storeConnectorSecret } from '@/server/master/connectors/secretStore';

export function rotateConnectorSecret(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: { provider: string; keyRef: string; nextPlainText: string; expiresAt?: string | null },
): void {
  storeConnectorSecret(repo, scope, {
    provider: input.provider,
    keyRef: input.keyRef,
    plainText: input.nextPlainText,
    expiresAt: input.expiresAt ?? null,
  });
}

export function revokeConnectorSecret(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: { provider: string; keyRef: string },
): void {
  const existing = repo.getConnectorSecret(scope, input.provider, input.keyRef);
  if (!existing) return;
  repo.upsertConnectorSecret(scope, {
    provider: existing.provider,
    keyRef: existing.keyRef,
    encryptedPayload: existing.encryptedPayload,
    issuedAt: existing.issuedAt,
    expiresAt: existing.expiresAt,
    revokedAt: new Date().toISOString(),
  });
}
