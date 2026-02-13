import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getClawHubService } from '../../../../src/server/clawhub/clawhubService';

export const runtime = 'nodejs';

interface UpdateBody {
  slug?: string;
  all?: boolean;
  version?: string;
  force?: boolean;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as UpdateBody;
    const slug = (body.slug || '').trim();
    const all = Boolean(body.all);

    if (!all && !slug) {
      return NextResponse.json(
        { ok: false, error: 'Update requires either "slug" or "all=true".' },
        { status: 400 },
      );
    }
    if (all && typeof body.version === 'string' && body.version.trim()) {
      return NextResponse.json(
        { ok: false, error: 'Update with "all=true" cannot specify "version".' },
        { status: 400 },
      );
    }

    const service = getClawHubService();
    const result = await service.update({
      slug: slug || undefined,
      all,
      version: typeof body.version === 'string' ? body.version : undefined,
      force: Boolean(body.force),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClawHub update failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
