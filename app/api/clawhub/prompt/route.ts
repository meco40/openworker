import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext(async () => {
  try {
    const service = getClawHubService();
    const prompt = await service.getPromptBlock();
    return NextResponse.json({ ok: true, prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build ClawHub prompt';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
