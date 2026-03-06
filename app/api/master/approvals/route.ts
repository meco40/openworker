import { NextResponse } from 'next/server';
import { isMasterApprovalControlPlaneEnabled } from '@/server/master/featureFlags';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isMasterApprovalControlPlaneEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Master approval control plane is disabled.' },
      { status: 404 },
    );
  }
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scope = resolveScopeFromRequest(request, userId);
    const repo = getMasterRepository();
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const runId = url.searchParams.get('runId') || undefined;
    const approvalRequests = repo
      .listApprovalRequests(scope, runId)
      .filter((request) => !status || request.status === status);
    return NextResponse.json({
      ok: true,
      approvals: approvalRequests,
      approvalRequests,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list Master approval requests';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
