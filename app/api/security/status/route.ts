import { NextResponse } from 'next/server';
import { buildSecurityStatusSnapshot } from '@/server/security/status';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext(async () => {
  try {
    const snapshot = buildSecurityStatusSnapshot();
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
