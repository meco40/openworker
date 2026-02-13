/**
 * POST /api/worker/[id]/test → Run automated tests on a webapp task
 */

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import { getWorkspaceManager } from '../../../../../src/server/worker/workspaceManager';
import { runWebappTests } from '../../../../../src/server/worker/workerTester';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTask(id);

    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    if (task.workspaceType !== 'webapp') {
      return NextResponse.json(
        { ok: false, error: 'Automated tests are only available for webapp tasks' },
        { status: 400 },
      );
    }

    const wsMgr = getWorkspaceManager();
    if (!wsMgr.exists(id)) {
      return NextResponse.json({ ok: false, error: 'Workspace not found' }, { status: 404 });
    }

    const workspacePath = wsMgr.getWorkspacePath(id);
    const testResult = runWebappTests(workspacePath);

    // Log test results as activity
    repo.addActivity({
      taskId: id,
      type: 'note',
      message: testResult.passed
        ? `Automatische Tests bestanden (${testResult.total}/${testResult.total})`
        : `Automatische Tests fehlgeschlagen (${testResult.failed}/${testResult.total} fehlgeschlagen)`,
      metadata: {
        total: testResult.total,
        failed: testResult.failed,
        results: testResult.results.map((r) => ({
          name: r.name,
          passed: r.passed,
          message: r.message,
        })),
      },
    });

    return NextResponse.json({ ok: true, testResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run tests';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
