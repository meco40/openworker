import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getClawHubService } from '../../../../src/server/clawhub/clawhubService';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const sort = (url.searchParams.get('sort') || 'newest').trim() || 'newest';

    const service = getClawHubService();
    const result = await service.explore(limit, sort);
    return NextResponse.json({ ok: true, ...result, source: 'explore-json' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClawHub explore failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
