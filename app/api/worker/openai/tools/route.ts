import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import {
  listOpenAiWorkerTools,
  setOpenAiWorkerToolEnabled,
} from '../../../../../src/server/worker/openai/openaiToolRegistry';

export const runtime = 'nodejs';

interface PatchBody {
  id?: string;
  enabled?: boolean;
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const tools = await listOpenAiWorkerTools();
    return NextResponse.json({ ok: true, tools });
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
    const id = String(body.id || '').trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: 'id is required.' }, { status: 400 });
    }
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'enabled must be a boolean.' }, { status: 400 });
    }

    const tool = await setOpenAiWorkerToolEnabled(id, body.enabled);
    return NextResponse.json({ ok: true, tool });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update OpenAI worker tool.';
    const status = message.includes('Unknown OpenAI worker tool') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
