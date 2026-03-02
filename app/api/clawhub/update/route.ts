import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { isValidClawHubSlug, toClawHubHttpStatus } from '@/server/clawhub/errors';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface UpdateBody {
  slug?: string;
  all?: boolean;
  version?: string;
  force?: boolean;
}

export const POST = withUserContext(async ({ request }) => {
  try {
    const body = (await request.json()) as UpdateBody;
    const slug = (body.slug || '').trim();
    const all = Boolean(body.all);

    if (!all && !slug) {
      return NextResponse.json(
        { ok: false, error: 'Update requires either "slug" or "all=true".' },
        { status: 400 },
      );
    }
    if (!all && !isValidClawHubSlug(slug)) {
      return NextResponse.json(
        { ok: false, error: `Invalid ClawHub skill slug: ${slug}` },
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
    const status = toClawHubHttpStatus(error, 500);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});
