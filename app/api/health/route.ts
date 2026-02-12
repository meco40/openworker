import { NextResponse } from 'next/server';
import { runHealthCommand } from '../../../src/commands/healthCommand';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseMemoryDiagnosticsEnabled(request?: Request): boolean {
  if (!request) return false;
  const raw = new URL(request.url).searchParams.get('memoryDiagnostics');
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

export async function GET(request?: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runHealthCommand({
      memoryDiagnosticsEnabled: parseMemoryDiagnosticsEnabled(request),
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect health diagnostics.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
