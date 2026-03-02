import { NextResponse } from 'next/server';
import {
  getExternalSkillHostStatus,
  stopExternalSkillHost,
} from '@/server/skills/externalSkillHost';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface ExternalHostActionBody {
  action?: unknown;
}

export const GET = withUserContext(async () => {
  try {
    return NextResponse.json({ ok: true, status: getExternalSkillHostStatus() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read external host status.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

export const POST = withUserContext(async ({ request }) => {
  try {
    const body = (await request.json()) as ExternalHostActionBody;
    const action = String(body.action || '')
      .trim()
      .toLowerCase();

    if (action !== 'stop') {
      return NextResponse.json(
        { ok: false, error: 'Unsupported action. Use action="stop".' },
        { status: 400 },
      );
    }

    stopExternalSkillHost();
    return NextResponse.json({ ok: true, status: getExternalSkillHostStatus() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to execute external host action.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
});
