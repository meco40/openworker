import { NextResponse } from 'next/server';
import { runDoctorCommand } from '@/commands/doctorCommand';
import { parseMemoryDiagnosticsEnabled } from '@/server/http/memoryDiagnostics';
import { withUserContext } from '../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withUserContext(async ({ request }) => {
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
});
