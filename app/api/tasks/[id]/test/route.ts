import { NextResponse } from 'next/server';
import { getTaskTestInfo, getTaskTestJobInfo, runTaskTests } from '@/server/tasks/testing';
import { withUserContext } from '../../../_shared/withUserContext';
import { canAccessTask } from '@/server/auth/workspaceAccess';

/**
 * POST /api/tasks/[id]/test
 * Route adapter for automated deliverable tests.
 */
export const POST = withUserContext<{ id: string }>(async ({ params, userContext }) => {
  const { id: taskId } = params;
  if (!canAccessTask(userContext, taskId)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
  return runTaskTests(taskId);
});

/**
 * GET /api/tasks/[id]/test
 * Route adapter for test endpoint info.
 */
export const GET = withUserContext<{ id: string }>(async ({ request, params, userContext }) => {
  const { id: taskId } = params;
  if (!canAccessTask(userContext, taskId)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
  const jobId = new URL(request.url).searchParams.get('jobId')?.trim();
  if (jobId) {
    return getTaskTestJobInfo(taskId, jobId);
  }
  return getTaskTestInfo(taskId);
});
