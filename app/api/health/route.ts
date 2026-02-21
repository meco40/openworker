import { NextResponse } from 'next/server';
import { runHealthCommand } from '@/commands/healthCommand';
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
