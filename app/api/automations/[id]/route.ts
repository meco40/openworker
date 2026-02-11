import { NextResponse } from 'next/server';

import { getAutomationService } from '../../../../src/server/automation/runtime';
import { resolveAutomationUserId } from '../../../../src/server/automation/httpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface UpdateAutomationBody {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}

export async function GET(_request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const rule = getAutomationService().getRule(id, userId);
  if (!rule) {
    return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, rule });
}

export async function PATCH(request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const body = (await request.json()) as UpdateAutomationBody;

    const rule = getAutomationService().updateRule(id, userId, {
      name: body.name,
      cronExpression: body.cronExpression,
      timezone: body.timezone,
      prompt: body.prompt,
      enabled: body.enabled,
    });

    if (!rule) {
      return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, rule });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update automation rule';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const userId = await resolveAutomationUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const deleted = getAutomationService().deleteRule(id, userId);
  if (!deleted) {
    return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}