import { NextResponse } from 'next/server';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { resolveRequestUserContext } from '@/server/auth/userContext';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ accountId: string }>;
};

async function resolveAccountId(context: RouteContext): Promise<string> {
  const params = await context.params;
  return String(params.accountId || '').trim();
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(context);
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'Missing accountId.' }, { status: 400 });
    }
    const requestUrl = new URL(_request.url);
    const purpose = requestUrl.searchParams.get('purpose')?.trim().toLowerCase();
    const fetchPurpose = purpose === 'embedding' ? 'embedding' : 'general';

    const service = getModelHubService();
    const models = await service.fetchModelsForAccountByPurpose(
      accountId,
      getModelHubEncryptionKey(),
      fetchPurpose,
    );

    return NextResponse.json({ ok: true, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to fetch models.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
