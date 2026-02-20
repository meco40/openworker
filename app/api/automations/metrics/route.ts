import { NextResponse } from 'next/server';

import { resolveAutomationUserId } from '@/server/automation/httpAuth';
import { getAutomationService } from '@/server/automation/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const service = getAutomationService();
  return NextResponse.json({
    ok: true,
    metrics: service.getMetrics(),
    leaseState: service.getLeaseState(),
  });
}
