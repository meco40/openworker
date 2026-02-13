import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getClawHubService } from '../../../../src/server/clawhub/clawhubService';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ slug: string }> };

interface PatchBody {
  enabled?: boolean;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { slug } = await context.params;
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      return NextResponse.json({ ok: false, error: 'Skill slug is required.' }, { status: 400 });
    }

    const body = (await request.json()) as PatchBody;
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { ok: false, error: 'PATCH requires boolean "enabled" in request body.' },
        { status: 400 },
      );
    }

    const service = getClawHubService();
    const skill = await service.setEnabled(normalizedSlug, body.enabled);
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update ClawHub skill state';
    const status = typeof message === 'string' && message.toLowerCase().includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
