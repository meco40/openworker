import { NextResponse } from 'next/server';
import { isMasterSubagentSessionsEnabled } from '@/server/master/featureFlags';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import {
  cancelSubagentSession,
  getSubagentSessionDetail,
} from '@/server/master/delegation/sessionService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

interface SessionPatchBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  action?: 'cancel';
  reason?: string;
}

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
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
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId);
    const detail = getSubagentSessionDetail(getMasterRepository(), scope, id);
    if (!detail) {
      return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read subagent session';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<Params> }) {
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
    const { id } = await params;
    const body = (await request.json()) as SessionPatchBody;
    if (body.action !== 'cancel') {
      return NextResponse.json({ ok: false, error: 'Unsupported session action' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const session = cancelSubagentSession(
      getMasterRepository(),
      scope,
      id,
      body.reason ?? 'cancelled',
    );
    if (!session) {
      return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update subagent session';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
