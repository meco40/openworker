import { NextResponse } from 'next/server';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface CreateAccountRequest {
  providerId?: string;
  label?: string;
  authMethod?: 'none' | 'api_key' | 'oauth';
  secret?: string;
  refreshToken?: string;
}

function validateCreateInput(body: CreateAccountRequest) {
  const providerId = String(body.providerId || '').trim();
  const label = String(body.label || '').trim();
  const authMethod = body.authMethod;
  const secret = String(body.secret || '').trim();
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : undefined;

  if (!providerId) throw new Error('providerId is required.');
  if (!label) throw new Error('label is required.');
  if (authMethod !== 'none' && authMethod !== 'api_key' && authMethod !== 'oauth') {
    throw new Error('authMethod must be none, api_key or oauth.');
  }
  if (authMethod !== 'none' && !secret) throw new Error('secret is required.');

  const provider = PROVIDER_CATALOG.find((item) => item.id === providerId);
  if (!provider) throw new Error(`Unsupported providerId: ${providerId}`);
  if (!provider.authMethods.includes(authMethod)) {
    throw new Error(`${provider.name} does not support auth method ${authMethod}.`);
  }

  return {
    providerId,
    label,
    authMethod,
    secret: authMethod === 'none' ? '' : secret,
    refreshToken,
  };
}

export const GET = withUserContext(async () => {
  try {
    const service = getModelHubService();
    return NextResponse.json({ ok: true, accounts: service.listAccounts() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list accounts.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

export const POST = withUserContext(async ({ request }) => {
  try {
    const payload = (await request.json()) as CreateAccountRequest;
    const input = validateCreateInput(payload);
    const service = getModelHubService();

    const account = service.connectAccount({
      providerId: input.providerId,
      label: input.label,
      authMethod: input.authMethod,
      secret: input.secret,
      refreshToken: input.refreshToken,
      encryptionKey: getModelHubEncryptionKey(),
    });

    return NextResponse.json({ ok: true, account });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create account.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
});
