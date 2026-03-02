import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { isValidClawHubSlug, toClawHubHttpStatus } from '@/server/clawhub/errors';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface InstallBody {
  slug?: string;
  version?: string;
  force?: boolean;
}

export const POST = withUserContext(async ({ request }) => {
  try {
    const body = (await request.json()) as InstallBody;
    const slug = (body.slug || '').trim();
    if (!slug) {
      return NextResponse.json(
        { ok: false, error: 'Install requires non-empty "slug".' },
        { status: 400 },
      );
    }
    if (!isValidClawHubSlug(slug)) {
      return NextResponse.json(
        { ok: false, error: `Invalid ClawHub skill slug: ${slug}` },
        { status: 400 },
      );
    }

    const service = getClawHubService();
    const result = await service.install({
      slug,
      version: typeof body.version === 'string' ? body.version : undefined,
      force: Boolean(body.force),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClawHub install failed';
    const status = toClawHubHttpStatus(error, 500);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});
