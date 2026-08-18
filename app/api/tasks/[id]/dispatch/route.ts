import { NextResponse } from 'next/server';
import { dispatchTask } from '@/server/tasks/dispatch';
import { withUserContext } from '../../../_shared/withUserContext';
import { canAccessTask } from '@/server/auth/workspaceAccess';

/**
 * POST /api/tasks/[id]/dispatch
 *
 * Thin route adapter: delegates orchestration to server task dispatch use-cases.
 */
export const POST = withUserContext<{ id: string }>(async ({ params, userContext }) => {
  try {
    const { id } = params;
    if (!canAccessTask(userContext, id)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const result = await dispatchTask(id);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
