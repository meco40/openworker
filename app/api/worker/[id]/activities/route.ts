/**
 * GET /api/worker/:id/activities → Get activity log for a task
 */

import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();

    const task = repo.getTaskForUser(id, userContext.userId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const activities = repo.getActivities(id, limit);

    return NextResponse.json({ ok: true, activities });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get activities';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
