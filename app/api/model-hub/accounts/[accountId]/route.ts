import { NextResponse } from 'next/server';
import { getModelHubService } from '@/server/model-hub/runtime';
import { resolveRequestUserContext } from '@/server/auth/userContext';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ accountId: string }>;
};

async function resolveAccountId(context: RouteContext): Promise<string> {
  const params = await context.params;
  return String(params.accountId || '').trim();
}

export async function DELETE(_request: Request, context: RouteContext) {
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
    const deleted = service.deleteAccount(accountId);
    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Account not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete account.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
