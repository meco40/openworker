import { NextResponse } from 'next/server';

import { getAutomationService } from '@/server/automation/runtime';
import { resolveAutomationUserId } from '@/server/automation/httpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateAutomationBody {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

function parseOptionalLimit(request?: Request): number | undefined {
  if (!request) {
    return undefined;
  }

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

export async function GET(request?: Request) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const service = getAutomationService();
  const limit = parseOptionalLimit(request);
  const rules = service.listRules(userId);
  const boundedRules = limit === undefined ? rules : rules.slice(0, limit);
  return NextResponse.json({ ok: true, rules: boundedRules });
}

export async function POST(request: Request) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as CreateAutomationBody;
    if (!body.name || !body.cronExpression || !body.prompt) {
      return NextResponse.json(
        { ok: false, error: 'name, cronExpression and prompt are required' },
        { status: 400 },
      );
    }

    const rule = getAutomationService().createRule({
      userId,
      name: body.name,
      cronExpression: body.cronExpression,
      timezone: body.timezone || 'UTC',
      prompt: body.prompt,
      enabled: body.enabled ?? true,
    });

    return NextResponse.json({ ok: true, rule });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create automation rule';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
