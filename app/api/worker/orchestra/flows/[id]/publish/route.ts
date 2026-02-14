import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../../src/server/auth/userContext';
import { canPublishOrchestra, normalizeWorkerRole } from '../../../../../../../src/server/worker/orchestraPolicy';
import {
  isWorkerOrchestraBuilderWriteEnabled,
  isWorkerOrchestraEnabled,
} from '../../../../../../../src/server/worker/orchestraFlags';
import { getOrchestraService } from '../../../../../../../src/server/worker/orchestraService';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }
    if (!isWorkerOrchestraBuilderWriteEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra builder write disabled' }, { status: 403 });
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
    const published = getOrchestraService().publishDraft(id, userContext.userId);
    if (!published) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, published });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to publish flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
