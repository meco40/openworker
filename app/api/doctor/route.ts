import { NextResponse } from 'next/server';
import { runDoctorCommand } from '@/commands/doctorCommand';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { parseMemoryDiagnosticsEnabled } from '@/server/http/memoryDiagnostics';
import { unauthorizedResponse } from '@/server/http/unauthorized';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return unauthorizedResponse();
  }

  try {
    const report = await runDoctorCommand({
      memoryDiagnosticsEnabled: parseMemoryDiagnosticsEnabled(request),
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect doctor diagnostics.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
