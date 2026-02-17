import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import {
  getOpenAiWorkerDefaultApprovalMode,
  listOpenAiWorkerTools,
  setOpenAiWorkerDefaultApprovalMode,
  setOpenAiWorkerToolApprovalMode,
  setOpenAiWorkerToolEnabled,
} from '../../../../../src/server/worker/openai/openaiToolRegistry';

export const runtime = 'nodejs';

interface PatchBody {
  id?: string;
  enabled?: boolean;
  approvalMode?: string;
  defaultApprovalMode?: string;
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const [tools, defaultApprovalMode] = await Promise.all([
      listOpenAiWorkerTools(),
      getOpenAiWorkerDefaultApprovalMode(),
    ]);
    return NextResponse.json({ ok: true, tools, defaultApprovalMode });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list OpenAI worker tools.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as PatchBody;

    if (typeof body.defaultApprovalMode === 'string' && body.defaultApprovalMode.trim().length > 0) {
      const defaultApprovalMode = await setOpenAiWorkerDefaultApprovalMode(
        body.defaultApprovalMode.trim() as 'deny' | 'ask_approve' | 'approve_always',
      );
      return NextResponse.json({ ok: true, defaultApprovalMode });
    }

    const id = String(body.id || '').trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: 'id is required.' }, { status: 400 });
    }

    if (typeof body.approvalMode === 'string' && body.approvalMode.trim().length > 0) {
      const tool = await setOpenAiWorkerToolApprovalMode(
        id,
        body.approvalMode.trim() as 'deny' | 'ask_approve' | 'approve_always',
      );
      return NextResponse.json({ ok: true, tool });
    }

    if (typeof body.enabled === 'boolean') {
      const tool = await setOpenAiWorkerToolEnabled(id, body.enabled);
      return NextResponse.json({ ok: true, tool });
    }
    return NextResponse.json(
      { ok: false, error: 'Provide either enabled(boolean), approvalMode(string), or defaultApprovalMode(string).' },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update OpenAI worker tool.';
    const status = message.includes('Unknown OpenAI worker tool')
      ? 404
      : message.includes('Invalid OpenAI worker approval mode')
        ? 400
        : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
