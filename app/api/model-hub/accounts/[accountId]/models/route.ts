import { NextResponse } from 'next/server';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { withUserContext } from '../../../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext<{ accountId: string }>(async ({ request, params }) => {
  try {
    const accountId = String(params.accountId || '').trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'Missing accountId.' }, { status: 400 });
    }
    const requestUrl = new URL(request.url);
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
});
