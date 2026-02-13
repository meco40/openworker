import { NextResponse } from 'next/server';

import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getClawHubService } from '../../../../src/server/clawhub/clawhubService';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const service = getClawHubService();
    const prompt = await service.getPromptBlock();
    return NextResponse.json({ ok: true, prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build ClawHub prompt';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
