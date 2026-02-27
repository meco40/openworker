import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { MasterCronBridge } from '@/server/master/cronBridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReminderBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  reminderId?: string;
  title?: string;
  message?: string;
  remindAt?: string;
  cronExpression?: string | null;
  status?: 'pending' | 'fired' | 'paused' | 'cancelled';
}

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const reminders = getMasterRepository().listReminders(scope);
    return NextResponse.json({ ok: true, reminders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list reminders';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as ReminderBody;
    if (!body.title || !body.message || !body.remindAt) {
      return NextResponse.json(
        { ok: false, error: 'title, message and remindAt are required' },
        { status: 400 },
      );
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const reminder = repo.createReminder(scope, {
      title: body.title,
      message: body.message,
      remindAt: body.remindAt,
      cronExpression: body.cronExpression ?? null,
      status: body.status ?? 'pending',
    });
    new MasterCronBridge(repo).syncReminder(scope, reminder);
    return NextResponse.json({ ok: true, reminder }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as ReminderBody;
    if (!body.reminderId) {
      return NextResponse.json({ ok: false, error: 'reminderId is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const reminder = repo.updateReminder(scope, body.reminderId, {
      title: body.title,
      message: body.message,
      remindAt: body.remindAt,
      cronExpression: body.cronExpression ?? undefined,
      status: body.status,
    });
    if (!reminder) {
      return NextResponse.json({ ok: false, error: 'Reminder not found' }, { status: 404 });
    }
    const bridge = new MasterCronBridge(repo);
    bridge.syncReminder(scope, reminder);
    if (reminder.status === 'paused') {
      bridge.pauseReminder(scope, reminder.id);
    }
    if (reminder.status === 'pending') {
      bridge.resumeReminder(scope, reminder.id);
    }
    return NextResponse.json({ ok: true, reminder });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to patch reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as ReminderBody;
    if (!body.reminderId) {
      return NextResponse.json({ ok: false, error: 'reminderId is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    new MasterCronBridge(repo).removeReminder(scope, body.reminderId);
    const deleted = repo.deleteReminder(scope, body.reminderId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
