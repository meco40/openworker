import { decryptSecret, encryptSecret, maskSecret } from '@/server/model-hub/crypto';
import { isJwtExpiringSoon, refreshOpenAICodexToken } from '@/server/model-hub/codexAuth';
import type { ModelHubRepository, ProviderAccountRecord } from '@/server/model-hub/repository';

export async function maybeRefreshOpenAICodexAccount(
  repository: ModelHubRepository,
  account: ProviderAccountRecord,
  encryptionKey: string,
): Promise<ProviderAccountRecord> {
  if (account.providerId !== 'openai-codex' || account.authMethod !== 'oauth') {
    return account;
  }
  if (!account.encryptedRefreshToken) {
    return account;
  }

  const currentAccessToken = decryptSecret(account.encryptedSecret, encryptionKey);
  if (!currentAccessToken?.trim()) {
    return account;
  }
  if (!isJwtExpiringSoon(currentAccessToken)) {
    return account;
  }

  const currentRefreshToken = decryptSecret(account.encryptedRefreshToken, encryptionKey);
  if (!currentRefreshToken?.trim()) {
    return account;
  }

  try {
    const refreshed = await refreshOpenAICodexToken(currentRefreshToken);
    repository.updateAccountCredentials({
      id: account.id,
      encryptedSecret: encryptSecret(refreshed.accessToken, encryptionKey),
      encryptedRefreshToken: encryptSecret(refreshed.refreshToken, encryptionKey),
      secretMasked: maskSecret(refreshed.accessToken),
    });
    return repository.getAccountRecordById(account.id) ?? account;
  } catch {
    return account;
  }
}
