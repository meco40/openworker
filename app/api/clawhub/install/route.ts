import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getClawHubService } from '../../../../src/server/clawhub/clawhubService';
import { isValidClawHubSlug, toClawHubHttpStatus } from '../../../../src/server/clawhub/errors';

export const runtime = 'nodejs';

interface InstallBody {
  slug?: string;
  version?: string;
  force?: boolean;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as InstallBody;
    const slug = (body.slug || '').trim();
    if (!slug) {
      return NextResponse.json({ ok: false, error: 'Install requires non-empty "slug".' }, { status: 400 });
    }
    if (!isValidClawHubSlug(slug)) {
      return NextResponse.json({ ok: false, error: `Invalid ClawHub skill slug: ${slug}` }, { status: 400 });
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
}
