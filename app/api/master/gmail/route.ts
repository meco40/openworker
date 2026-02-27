import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { executeGmailAction } from '@/server/master/connectors/gmail/actions';
import { storeConnectorSecret } from '@/server/master/connectors/secretStore';
import { revokeConnectorSecret } from '@/server/master/connectors/secretPolicies';
import type { ApprovalDecision } from '@/server/master/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GmailBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  runId?: string;
  stepId?: string;
  action?: 'read' | 'search' | 'draft' | 'send' | 'connect' | 'revoke';
  query?: string;
  draft?: { to: string; subject: string; body: string };
  decision?: ApprovalDecision;
  fingerprint?: string;
  accessToken?: string;
  expiresAt?: string | null;
  keyRef?: string;
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as GmailBody;
    if (!body.action) {
      return NextResponse.json({ ok: false, error: 'action is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);

    if (body.action === 'connect') {
      const accessToken = String(body.accessToken || '').trim();
      if (!accessToken) {
        return NextResponse.json({ ok: false, error: 'accessToken is required' }, { status: 400 });
      }
      storeConnectorSecret(getMasterRepository(), scope, {
        provider: 'gmail',
        keyRef: body.keyRef || 'default',
        plainText: accessToken,
        expiresAt: body.expiresAt ?? null,
      });
      return NextResponse.json({ ok: true, connected: true }, { status: 200 });
    }

    if (body.action === 'revoke') {
      revokeConnectorSecret(getMasterRepository(), scope, {
        provider: 'gmail',
        keyRef: body.keyRef || 'default',
      });
      return NextResponse.json({ ok: true, revoked: true }, { status: 200 });
    }

    if (!body.runId || !body.stepId) {
      return NextResponse.json(
        { ok: false, error: 'action, runId and stepId are required' },
        { status: 400 },
      );
    }
    const result = await executeGmailAction(getMasterRepository(), {
      scope,
      runId: body.runId,
      stepId: body.stepId,
      action: body.action,
      query: body.query,
      draft: body.draft,
      decision: body.decision,
      fingerprint: body.fingerprint,
    });
    if (result.approvalRequired) {
      return NextResponse.json(result, { status: 202 });
    }
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute gmail action';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
