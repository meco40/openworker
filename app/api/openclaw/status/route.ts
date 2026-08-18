import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { withUserContext } from '../../_shared/withUserContext';
import { getAccessibleSessionCount } from '@/server/auth/workspaceAccess';

// GET /api/openclaw/status - Compatibility status endpoint for Mission Control runtime
export const GET = withUserContext(async ({ userContext }) => {
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
            gateway_url: runtimeUrl,
            mode,
          },
          { status: 503 },
        );
      }
    }

    let sessionsCount = 0;
    try {
      sessionsCount = getAccessibleSessionCount(userContext);
    } catch (error) {
      console.warn('Mission Control runtime session probe failed:', error);
    }

    return NextResponse.json({
      connected: true,
      sessions_count: sessionsCount,
      runtime_url: runtimeUrl,
      gateway_url: runtimeUrl,
      mode,
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
