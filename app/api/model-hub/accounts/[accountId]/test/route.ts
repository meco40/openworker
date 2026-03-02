import { NextResponse } from 'next/server';
import { testProviderAccountConnectivity } from '@/server/model-hub/connectivity';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { withUserContext } from '../../../../_shared/withUserContext';

export const runtime = 'nodejs';

interface ConnectivityRequestBody {
  model?: string;
}

export const POST = withUserContext<{ accountId: string }>(async ({ request, params }) => {
  try {
    const accountId = String(params.accountId || '').trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'Missing accountId.' }, { status: 400 });
    }

    const service = getModelHubService();
    const account = await service.getUsableAccountById(accountId, getModelHubEncryptionKey());
    if (!account) {
      return NextResponse.json({ ok: false, error: 'Account not found.' }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as ConnectivityRequestBody;
    const model = typeof body.model === 'string' ? body.model.trim() : undefined;

    const connectivity = await testProviderAccountConnectivity(
      account,
      getModelHubEncryptionKey(),
      {
        model,
      },
    );
    service.updateHealth(accountId, connectivity.ok, connectivity.message);

    return NextResponse.json({ ok: true, connectivity });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connectivity test failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
