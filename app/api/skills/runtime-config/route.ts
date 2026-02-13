import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import {
  getSkillRuntimeConfigStore,
  resolveSkillRuntimeConfigStatus,
} from '../../../../src/server/skills/runtimeConfig';

export const runtime = 'nodejs';

interface PutBody {
  id?: string;
  value?: string;
}

function resolveConfigId(request: Request, body?: { id?: string }): string {
  const fromBody = String(body?.id || '').trim();
  if (fromBody) return fromBody;

  const url = new URL(request.url);
  const fromQuery = String(url.searchParams.get('id') || '').trim();
  if (fromQuery) return fromQuery;

  throw new Error('id is required.');
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const configs = resolveSkillRuntimeConfigStatus(getSkillRuntimeConfigStore());
    return NextResponse.json({ ok: true, configs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load runtime config.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as PutBody;
    const id = resolveConfigId(request, body);
    const value = String(body.value || '').trim();

    if (!value) {
      return NextResponse.json({ ok: false, error: 'value is required.' }, { status: 400 });
    }

    const store = getSkillRuntimeConfigStore();
    store.setValue(id, value);

    const config = resolveSkillRuntimeConfigStatus(store).find((item) => item.id === id);
    return NextResponse.json({ ok: true, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save runtime config.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    let body: { id?: string } | undefined;
    try {
      body = (await request.json()) as { id?: string };
    } catch {
      body = undefined;
    }

    const id = resolveConfigId(request, body);
    const store = getSkillRuntimeConfigStore();
    store.deleteValue(id);

    const config = resolveSkillRuntimeConfigStatus(store).find((item) => item.id === id);
    return NextResponse.json({ ok: true, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to clear runtime config.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
