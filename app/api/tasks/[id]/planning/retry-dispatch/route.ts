import { NextResponse } from 'next/server';
import { queryOne, run, getDb } from '@/lib/db';
import { dispatchTask } from '@/server/tasks/dispatch';
import { withUserContext } from '../../../../_shared/withUserContext';
import { canAccessTask } from '@/server/auth/workspaceAccess';

/**
 * POST /api/tasks/[id]/planning/retry-dispatch
 *
 * Retries the auto-dispatch for a completed planning task
 * This endpoint allows users to retry failed dispatches from the UI
 */
export const POST = withUserContext<{ id: string }>(async ({ params, userContext }) => {
  const { id: taskId } = params;
  if (!canAccessTask(userContext, taskId)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  try {
    // Get task details
    const task = queryOne<{
      id: string;
      title: string;
      assigned_agent_id?: string;
      workspace_id?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
      status: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if planning is complete
    if (!task.planning_complete) {
      return NextResponse.json(
        {
          error: 'Cannot retry dispatch: planning is not complete',
        },
        { status: 400 },
      );
    }

    // Check if there's an assigned agent
    if (!task.assigned_agent_id) {
      return NextResponse.json(
        {
          error: 'Cannot retry dispatch: no agent assigned',
        },
        { status: 400 },
      );
    }

    // Get agent name for logging
    const agent = queryOne<{ name: string }>('SELECT name FROM agents WHERE id = ?', [
      task.assigned_agent_id,
    ]);

    // Trigger the dispatch
    const dispatchResult = await dispatchTask(task.id);
    const result = {
      success: dispatchResult.status >= 200 && dispatchResult.status < 300,
      error:
        dispatchResult.status >= 200 && dispatchResult.status < 300
          ? undefined
          : String(
              (dispatchResult.body as { error?: unknown; message?: unknown }).error ||
                (dispatchResult.body as { error?: unknown; message?: unknown }).message ||
                `Dispatch failed (HTTP ${dispatchResult.status})`,
            ),
    };

    // Use transaction to ensure atomic updates
    const db = getDb();
    const transaction = db.transaction(() => {
      if (result.success) {
        // Dispatch route already sets status (typically to in_progress), so keep it.
        run(
          `
          UPDATE tasks 
          SET planning_dispatch_error = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `,
          [taskId],
        );
      } else {
        // Store the error for display, keep as 'pending_dispatch'
        run(
          `
          UPDATE tasks 
          SET planning_dispatch_error = ?,
              status = 'pending_dispatch',
              updated_at = datetime('now')
          WHERE id = ?
        `,
          [result.error, taskId],
        );
      }
    });

    transaction();

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: 'Dispatch retry successful',
      });
    } else {
      return NextResponse.json(
        {
          error: 'Dispatch retry failed',
          details: result.error,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('Failed to retry dispatch:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Store the error in the database for user display
    run(
      `
      UPDATE tasks 
      SET planning_dispatch_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `,
      [`Retry error: ${errorMessage}`, taskId],
    );

    return NextResponse.json(
      {
        error: 'Failed to retry dispatch',
        details: errorMessage,
      },
      { status: 500 },
    );
  }
});
