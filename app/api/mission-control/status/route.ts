import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getSseDiagnostics } from '@/lib/events';
import { withUserContext } from '../../_shared/withUserContext';

/**
 * GET /api/mission-control/status
 *
 * Reports integrated runtime health for Mission Control UI.
 */
export const GET = withUserContext(async () => {
  try {
    const client = getOpenClawClient();
    const runtimeUrl = client.getGatewayUrl();
    const mode = client.getMode();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          {
            connected: false,
            error: 'Failed to initialize Mission Control runtime',
            runtime_url: runtimeUrl,
            mode,
          },
          { status: 503 },
        );
      }
    }

    let sessionsCount = 0;
    try {
      const sessions = await client.listSessions();
      sessionsCount = sessions.length;
    } catch (error) {
      console.warn('Mission Control runtime session probe failed:', error);
    }

    return NextResponse.json({
      connected: true,
      runtime_url: runtimeUrl,
      mode,
      sessions_count: sessionsCount,
      sse: getSseDiagnostics(),
    });
  } catch (error) {
    console.error('Mission Control runtime status check failed:', error);
    return NextResponse.json(
      {
        connected: false,
        error: 'Internal server error',
      },
      { status: 500 },
    );
  }
});
