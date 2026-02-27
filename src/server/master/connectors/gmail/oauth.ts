import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { decryptConnectorSecret } from '@/server/master/connectors/secretStore';

export interface GmailOAuthState {
  accessToken: string;
  issuedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function loadGmailOAuthState(
  repo: MasterRepository,
  scope: WorkspaceScope,
  keyRef = 'default',
): GmailOAuthState | null {
  const secret = repo.getConnectorSecret(scope, 'gmail', keyRef);
  if (!secret || secret.revokedAt) return null;
  return {
    accessToken: decryptConnectorSecret(secret.encryptedPayload),
    issuedAt: secret.issuedAt,
    expiresAt: secret.expiresAt,
    revokedAt: secret.revokedAt,
  };
}
