import { NextResponse } from 'next/server';
import { buildSecurityStatusSnapshot } from '../../../../src/server/security/status';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const snapshot = buildSecurityStatusSnapshot();
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
