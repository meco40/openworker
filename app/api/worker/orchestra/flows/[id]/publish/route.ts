import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../../../src/server/worker/workerRepository';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const published = repo.publishFlowDraft(id, userContext.userId);
    if (!published) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, published });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to publish flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
