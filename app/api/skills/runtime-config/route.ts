import { NextResponse } from 'next/server';
import {
  getSkillRuntimeConfigStore,
  resolveSkillRuntimeConfigStatus,
} from '@/server/skills/runtimeConfig';
import { withUserContext } from '../../_shared/withUserContext';

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

export const GET = withUserContext(async () => {
  try {
    const configs = resolveSkillRuntimeConfigStatus(getSkillRuntimeConfigStore());
    return NextResponse.json({ ok: true, configs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load runtime config.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

export const PUT = withUserContext(async ({ request }) => {
  try {
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
});

export const DELETE = withUserContext(async ({ request }) => {
  try {
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
});
