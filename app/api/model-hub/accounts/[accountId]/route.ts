import { NextResponse } from 'next/server';
import { getModelHubService } from '@/server/model-hub/runtime';
import { withUserContext } from '../../../_shared/withUserContext';

export const runtime = 'nodejs';

export const DELETE = withUserContext<{ accountId: string }>(async ({ params }) => {
  try {
    const accountId = String(params.accountId || '').trim();
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
});
