import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import {
  getExternalSkillHostStatus,
  stopExternalSkillHost,
} from '@/server/skills/externalSkillHost';

export const runtime = 'nodejs';

interface ExternalHostActionBody {
  action?: unknown;
}

function isAuthorized(userContext: { userId: string; authenticated: boolean } | null): boolean {
  return Boolean(userContext);
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!isAuthorized(userContext)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({ ok: true, status: getExternalSkillHostStatus() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read external host status.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!isAuthorized(userContext)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

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
}
