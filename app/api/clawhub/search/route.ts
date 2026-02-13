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
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) {
      return NextResponse.json(
        { ok: false, error: 'Missing query parameter "q".' },
        { status: 400 },
      );
    }

    const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;

    const service = getClawHubService();
    const result = await service.search(query, limit);
    return NextResponse.json({ ok: true, ...result, source: 'search-text' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClawHub search failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
