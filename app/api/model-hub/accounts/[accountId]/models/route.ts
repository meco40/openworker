import { NextResponse } from 'next/server';
import {
  getModelHubEncryptionKey,
  getModelHubService,
} from '../../../../../../src/server/model-hub/runtime';

export const runtime = 'nodejs';

type RouteContext = {
  params: { accountId: string } | Promise<{ accountId: string }>;
};

async function resolveAccountId(context: RouteContext): Promise<string> {
  const params = await Promise.resolve(context.params);
  return String(params.accountId || '').trim();
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const accountId = await resolveAccountId(context);
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'Missing accountId.' }, { status: 400 });
    }

    const service = getModelHubService();
    const models = await service.fetchModelsForAccount(accountId, getModelHubEncryptionKey());

    return NextResponse.json({ ok: true, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to fetch models.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
