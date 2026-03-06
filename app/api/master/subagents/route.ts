import { NextResponse } from 'next/server';
import { isMasterSubagentSessionsEnabled } from '@/server/master/featureFlags';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isMasterSubagentSessionsEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Master subagent sessions are disabled.' },
      { status: 404 },
    );
  }
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const url = new URL(request.url);
    const runId = url.searchParams.get('runId') || undefined;
    const sessions = getMasterRepository().listSubagentSessions(scope, runId);
    return NextResponse.json({ ok: true, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list subagent sessions';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
