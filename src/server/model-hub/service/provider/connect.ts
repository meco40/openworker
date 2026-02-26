import { encryptSecret, maskSecret } from '@/server/model-hub/crypto';
import type { ModelHubRepository, ProviderAccountView } from '@/server/model-hub/repository';
import type { ConnectProviderAccountInput } from '../types';

export function connectProviderAccount(
  repository: ModelHubRepository,
  input: ConnectProviderAccountInput,
): ProviderAccountView {
  const encryptedSecret = encryptSecret(input.secret, input.encryptionKey);
  const encryptedRefreshToken = input.refreshToken
    ? encryptSecret(input.refreshToken, input.encryptionKey)
    : null;

  return repository.createAccount({
    providerId: input.providerId,
    label: input.label,
    authMethod: input.authMethod,
    encryptedSecret,
    encryptedRefreshToken,
    secretMasked: maskSecret(input.secret),
  });
}
