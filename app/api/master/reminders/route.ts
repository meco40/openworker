import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import { MasterCronBridge } from '@/server/master/cronBridge';
import { MasterRemindersService } from '@/server/master/reminders';

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
    const reminders = new MasterRemindersService(getMasterRepository()).list(scope);
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
    const reminder = new MasterRemindersService(repo, {
      scheduler: new MasterCronBridge(repo),
    }).create(scope, {
      title: body.title,
      message: body.message,
      remindAt: body.remindAt,
      cronExpression: body.cronExpression ?? null,
    });
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
    const reminder = new MasterRemindersService(repo, {
      scheduler: new MasterCronBridge(repo),
    }).update(scope, body.reminderId, {
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
    const deleted = new MasterRemindersService(repo, {
      scheduler: new MasterCronBridge(repo),
    }).delete(scope, body.reminderId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete reminder';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
