import { NextResponse } from 'next/server';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { getMasterRepository } from '@/server/master/runtime';
import { collectMasterMetrics } from '@/server/master/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scope = resolveScopeFromRequest(request, userId);
    const metrics = collectMasterMetrics(getMasterRepository(), scope);
    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to collect metrics';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
