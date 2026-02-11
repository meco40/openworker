import { NextResponse } from 'next/server';

import { getAutomationService } from '../../../../../src/server/automation/runtime';
import { resolveAutomationUserId } from '../../../../../src/server/automation/httpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const runs = getAutomationService().listRuns(id, userId);
  return NextResponse.json({ ok: true, runs });
}