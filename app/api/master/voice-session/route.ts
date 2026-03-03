import { NextResponse } from 'next/server';
import { getModelHubService, getModelHubEncryptionKey } from '@/server/model-hub/runtime';
import { decryptSecret } from '@/server/model-hub/crypto';
import { withUserContext } from '../../_shared/withUserContext';
import { fetchWithPolicy } from '@/server/http/fetchWithPolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_VOICES = new Set(['Ara', 'Rex', 'Sal', 'Eve', 'Leo']);
const XAI_REALTIME_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

export const GET = withUserContext(async ({ request }): Promise<NextResponse> => {
  // Resolve xAI API key from Model Hub
  let apiKey: string;
  try {
    const svc = getModelHubService();
    const encKey = getModelHubEncryptionKey();

    const xaiAccount = svc
      .listAccounts()
      .filter((a) => a.providerId === 'xai')
      .map((a) => svc.getAccountById(a.id))
      .find(Boolean);

    if (!xaiAccount) {
      return NextResponse.json(
        { ok: false, error: 'No xAI account configured in Model Hub' },
        { status: 503 },
      );
    }

    apiKey = decryptSecret(xaiAccount.encryptedSecret, encKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resolve xAI credentials';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  // Optional voice selection via query param, default Ara
  const voiceParam = new URL(request.url).searchParams.get('voice') ?? 'Ara';
  const voice = VALID_VOICES.has(voiceParam) ? voiceParam : 'Ara';

  // Request ephemeral token from xAI
  let token: string;
  let expiresAt: number;
  try {
    const xaiRes = await fetchWithPolicy(
      XAI_REALTIME_SECRETS_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      },
      { timeoutMs: 10_000, retries: 1 },
    );

    if (!xaiRes.ok) {
      const errBody = await xaiRes.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `xAI returned ${xaiRes.status}: ${errBody}` },
        { status: 502 },
      );
    }

    const xaiData = (await xaiRes.json()) as Record<string, unknown>;
    // xAI returns { client_secret: { value, expires_at } } or similar shape
    const clientSecret = xaiData.client_secret as Record<string, unknown> | undefined;
    const rawToken =
      (clientSecret?.value as string | undefined) ??
      (xaiData.token as string | undefined) ??
      (xaiData.value as string | undefined);

    if (!rawToken) {
      return NextResponse.json(
        { ok: false, error: 'Unexpected response shape from xAI token endpoint' },
        { status: 502 },
      );
    }

    token = rawToken;
    expiresAt =
      (clientSecret?.expires_at as number | undefined) ??
      (xaiData.expires_at as number | undefined) ??
      Math.floor(Date.now() / 1000) + 300;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'xAI token request failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }

  return NextResponse.json({ ok: true, token, voice, expiresAt });
});
