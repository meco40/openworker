import {
  collectEngineeringMetricsSnapshot,
  parseWindowDays,
} from '@/server/stats/engineeringMetricsService';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const url = new URL(request.url);
    const windowDays = parseWindowDays(url.searchParams.get('windowDays'));
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim() || null;
    const snapshot = collectEngineeringMetricsSnapshot({
      userId: userContext.userId,
      workspaceId,
      windowDays,
    });
    return Response.json({ ok: true, snapshot });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to compute engineering metrics';
    const status = message.includes('windowDays') ? 400 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
});
