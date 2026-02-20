import { NextResponse } from 'next/server';

import { getAutomationService } from '@/server/automation/runtime';
import { resolveAutomationUserId } from '@/server/automation/httpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const run = getAutomationService().createManualRun(id, userId);
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create manual run';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
