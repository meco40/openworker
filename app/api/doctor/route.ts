import { NextResponse } from 'next/server';
import { runDoctorCommand } from '../../../src/commands/doctorCommand';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runDoctorCommand();
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect doctor diagnostics.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
