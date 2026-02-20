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

export async function GET() {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const service = getAutomationService();
  const rules = service.listRules(userId);
  return NextResponse.json({ ok: true, rules });
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
