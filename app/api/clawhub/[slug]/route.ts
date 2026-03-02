import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { isValidClawHubSlug, toClawHubHttpStatus } from '@/server/clawhub/errors';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

type SlugParams = { slug: string };

interface PatchBody {
  enabled?: boolean;
}

export const PATCH = withUserContext<SlugParams>(async ({ request, params }) => {
  try {
    const { slug } = params;
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      return NextResponse.json({ ok: false, error: 'Skill slug is required.' }, { status: 400 });
    }
    if (!isValidClawHubSlug(normalizedSlug)) {
      return NextResponse.json(
        { ok: false, error: `Invalid ClawHub skill slug: ${normalizedSlug}` },
        { status: 400 },
      );
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
    const status = toClawHubHttpStatus(error, 500);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});

export const DELETE = withUserContext<SlugParams>(async ({ params }) => {
  try {
    const { slug } = params;
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      return NextResponse.json({ ok: false, error: 'Skill slug is required.' }, { status: 400 });
    }
    if (!isValidClawHubSlug(normalizedSlug)) {
      return NextResponse.json(
        { ok: false, error: `Invalid ClawHub skill slug: ${normalizedSlug}` },
        { status: 400 },
      );
    }

    const service = getClawHubService();
    const result = await service.uninstall(normalizedSlug);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to uninstall ClawHub skill';
    const status = toClawHubHttpStatus(error, 500);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
});
