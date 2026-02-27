import type { MasterRepository } from '@/server/master/repository';
import type { MasterConnectorSecret, WorkspaceScope } from '@/server/master/types';

const SECRET_PREFIX = 'enc:v1:';

export function encryptConnectorSecret(plainText: string): string {
  return `${SECRET_PREFIX}${Buffer.from(plainText, 'utf8').toString('base64url')}`;
}

export function decryptConnectorSecret(cipherText: string): string {
  if (!cipherText.startsWith(SECRET_PREFIX)) {
    throw new Error('Unsupported secret format.');
  }
  return Buffer.from(cipherText.slice(SECRET_PREFIX.length), 'base64url').toString('utf8');
}

export function storeConnectorSecret(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: { provider: string; keyRef: string; plainText: string; expiresAt?: string | null },
): MasterConnectorSecret {
  return repo.upsertConnectorSecret(scope, {
    provider: input.provider,
    keyRef: input.keyRef,
    encryptedPayload: encryptConnectorSecret(input.plainText),
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  });
}
