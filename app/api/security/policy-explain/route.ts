import { NextResponse } from 'next/server';
import { buildEffectivePolicyExplainSnapshot } from '@/server/security/policyExplain';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const snapshot = await buildEffectivePolicyExplainSnapshot();
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
