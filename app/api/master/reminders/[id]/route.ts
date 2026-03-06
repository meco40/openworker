import { NextResponse } from 'next/server';
import { MasterCronBridge } from '@/server/master/cronBridge';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { MasterRemindersService } from '@/server/master/reminders';
import { getMasterRepository } from '@/server/master/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReminderBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  title?: string;
  message?: string;
  remindAt?: string;
  cronExpression?: string | null;
  status?: 'pending' | 'fired' | 'paused' | 'cancelled';
}

function service() {
  const repo = getMasterRepository();
  return new MasterRemindersService(repo, {
    scheduler: new MasterCronBridge(repo),
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId);
    const reminder = service().get(scope, id);
    if (!reminder) {
      return NextResponse.json({ ok: false, error: 'Reminder not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, reminder });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as ReminderBody;
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId, body);
    const reminder = service().update(scope, id, {
      title: body.title,
      message: body.message,
      remindAt: body.remindAt,
      cronExpression: body.cronExpression ?? undefined,
      status: body.status,
    });
    if (!reminder) {
      return NextResponse.json({ ok: false, error: 'Reminder not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, reminder });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to patch reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId);
    const deleted = service().delete(scope, id);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
