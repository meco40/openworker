import { NextResponse } from 'next/server';
import { testProviderAccountConnectivity } from '@/server/model-hub/connectivity';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { resolveRequestUserContext } from '@/server/auth/userContext';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ accountId: string }>;
};

interface ConnectivityRequestBody {
  model?: string;
}

async function resolveAccountId(context: RouteContext): Promise<string> {
  const params = await context.params;
  return String(params.accountId || '').trim();
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(context);
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
}
