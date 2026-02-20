import { NextResponse } from 'next/server';

import { getAutomationService } from '@/server/automation/runtime';
import { resolveAutomationUserId } from '@/server/automation/httpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

function parseOptionalLimit(request: Request): number | undefined {
  const rawLimit = new URL(request.url).searchParams.get('limit');
  if (rawLimit === null) {
    return undefined;
  }

  const parsedLimit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsedLimit)) {
    return undefined;
  }

  return Math.min(Math.max(parsedLimit, MIN_LIMIT), MAX_LIMIT);
}

export async function GET(request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const limit = parseOptionalLimit(request);
  const runs = getAutomationService().listRuns(id, userId, limit);
  return NextResponse.json({ ok: true, runs });
}
