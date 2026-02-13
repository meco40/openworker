import { logFromSystemEvent } from '../../../../src/logging/logService';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/logs/ingest — persists a log from the client-side event system.
 *
 * Body: { type: string, message: string }
 */
export async function POST(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as { type?: string; message?: string };

  if (!body.type || !body.message) {
    return Response.json({ ok: false, error: 'type and message are required' }, { status: 400 });
  }

  const entry = logFromSystemEvent(body.type, body.message);
  return Response.json({ ok: true, entry });
}
