import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext(async ({ request }) => {
  try {
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
});
