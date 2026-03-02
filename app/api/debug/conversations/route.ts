import { NextResponse } from 'next/server';
import { getPromptDispatchRepository } from '@/server/stats/promptDispatchRepository';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withUserContext(async () => {
  try {
    const conversations = getPromptDispatchRepository().listConversationSummaries();
    return NextResponse.json({ ok: true, conversations });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
