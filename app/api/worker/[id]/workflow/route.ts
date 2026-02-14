import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import type { OrchestraFlowGraph } from '../../../../../src/server/worker/orchestraGraph';
import {
  isWorkerOrchestraEnabled,
  isWorkerWorkflowTabEnabled,
} from '../../../../../src/server/worker/orchestraFlags';
import {
  buildNodeStatusMap,
  buildWorkerWorkflowPayload,
} from '../../../../../src/server/worker/orchestraWorkflow';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled() || !isWorkerWorkflowTabEnabled()) {
      return NextResponse.json({ ok: false, error: 'Workflow disabled' }, { status: 404 });
    }

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

    if (!task.flowPublishedId) {
      return NextResponse.json({
        ok: true,
        workflow: {
          taskId: task.id,
          runId: task.currentRunId || null,
          flowPublishedId: null,
          nodes: [],
          edges: [],
          activePath: [],
          currentNodeId: null,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const flow = repo.getFlowPublished(task.flowPublishedId, userContext.userId);
    if (!flow) {
      return NextResponse.json({ ok: false, error: 'Published flow not found' }, { status: 404 });
    }

    let graph: OrchestraFlowGraph;
    try {
      graph = JSON.parse(flow.graphJson) as OrchestraFlowGraph;
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Published flow graph is invalid JSON' },
        { status: 500 },
      );
    }

    const runNodes = task.currentRunId ? repo.listRunNodes(task.currentRunId) : [];
    const workflow = buildWorkerWorkflowPayload({
      taskId: task.id,
      runId: task.currentRunId || null,
      flowPublishedId: flow.id,
      graph,
      nodeStatuses: buildNodeStatusMap(runNodes),
    });

    return NextResponse.json({ ok: true, workflow });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load workflow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
