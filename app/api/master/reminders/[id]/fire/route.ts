import { NextResponse } from 'next/server';
import { MasterCronBridge } from '@/server/master/cronBridge';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { MasterRemindersService } from '@/server/master/reminders';
import { getMasterRepository } from '@/server/master/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface FireBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  firedAt?: string;
  source?: 'manual' | 'cron' | 'api';
  summary?: string | null;
  automationRuleId?: string | null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as FireBody;
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const reminderService = new MasterRemindersService(repo, {
      scheduler: new MasterCronBridge(repo),
    });
    const result = reminderService.fire(scope, id, {
      firedAt: body.firedAt,
      source: body.source,
      summary: body.summary ?? null,
      automationRuleId: body.automationRuleId ?? null,
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: 'Reminder not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fire reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
