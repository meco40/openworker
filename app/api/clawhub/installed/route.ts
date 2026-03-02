import { NextResponse } from 'next/server';

import { getClawHubService } from '@/server/clawhub/clawhubService';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext(async () => {
  try {
    const service = getClawHubService();
    const skills = await service.syncInstalledFromLockfile();
    return NextResponse.json({ ok: true, skills });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list installed ClawHub skills';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
