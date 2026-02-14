import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../../src/server/auth/userContext';
import {
  canPublishOrchestra,
  normalizeWorkerRole,
} from '../../../../../../../src/server/worker/orchestraPolicy';
import {
  isWorkerOrchestraBuilderWriteEnabled,
  isWorkerOrchestraEnabled,
} from '../../../../../../../src/server/worker/orchestraFlags';
import { getOrchestraService } from '../../../../../../../src/server/worker/orchestraService';
import { getWorkerRepository } from '../../../../../../../src/server/worker/workerRepository';
import {
  enforceOrchestraGraphLimits,
} from '../../../../../../../src/server/worker/orchestraPolicy';
import type { OrchestraFlowGraph } from '../../../../../../../src/server/worker/orchestraGraph';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }
    if (!isWorkerOrchestraBuilderWriteEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Orchestra builder write disabled' },
        { status: 403 },
      );
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const workerRole = normalizeWorkerRole(_request.headers.get('x-worker-role'));
    if (!canPublishOrchestra(workerRole)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    const orchestraService = getOrchestraService();

    // Validate graph before publishing — drafts can be incomplete, published flows must be valid
    const draft = getWorkerRepository().getFlowDraft(id, userContext.userId);
    if (!draft) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }
    let graph: OrchestraFlowGraph;
    try {
      graph = JSON.parse(draft.graphJson || '{}') as OrchestraFlowGraph;
    } catch {
      return NextResponse.json({ ok: false, error: 'Ungültiges Graph-JSON im Draft' }, { status: 400 });
    }
    const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    if (graphNodes.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Flow kann nicht veröffentlicht werden — mindestens ein Knoten erforderlich.' },
        { status: 400 },
      );
    }
    const validation = orchestraService.validateGraphForUser(userContext.userId, graph);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }
    const limitCheck = enforceOrchestraGraphLimits(validation.graph);
    if (!limitCheck.ok) {
      return NextResponse.json({ ok: false, error: limitCheck.error }, { status: 400 });
    }

    const published = orchestraService.publishDraft(id, userContext.userId);
    if (!published) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, published });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to publish flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
