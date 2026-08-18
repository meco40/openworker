import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { queryAll } from '@/lib/db';
import { withUserContext } from '../../_shared/withUserContext';
import type { OpenClawSession } from '@/lib/types';
import {
  getAccessibleWorkspaceIds,
  hasWorkspaceAccess,
  normalizeWorkspaceId,
} from '@/server/auth/workspaceAccess';

// GET /api/openclaw/sessions - List runtime sessions
export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const { searchParams } = new URL(request.url);
    const sessionType = searchParams.get('session_type');
    const status = searchParams.get('status');

    // If filtering by database fields, query the database
    if (sessionType || status) {
      const workspaceIds = getAccessibleWorkspaceIds(userContext);
      if (workspaceIds.length === 0) {
        return NextResponse.json([]);
      }
      let sql = `
        SELECT s.*
        FROM openclaw_sessions s
        LEFT JOIN agents a ON a.id = s.agent_id
        LEFT JOIN tasks t ON t.id = s.task_id
        WHERE COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) IN (${workspaceIds
          .map(() => '?')
          .join(', ')})`;
      const params: unknown[] = [...workspaceIds];

      if (sessionType) {
        sql += ' AND session_type = ?';
        params.push(sessionType);
      }

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      sql += ' ORDER BY created_at DESC';

      const sessions = queryAll<OpenClawSession>(sql, params);
      return NextResponse.json(sessions);
    }

    // Otherwise, query runtime for live sessions
    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to Mission Control runtime' },
          { status: 503 },
        );
      }
    }

    const workspaceIds = getAccessibleWorkspaceIds(userContext);
    if (workspaceIds.length === 0) {
      return NextResponse.json({ sessions: [] });
    }
    const accessibleSessionIds = new Set(
      queryAll<{ openclaw_session_id: string }>(
        `
          SELECT s.openclaw_session_id
          FROM openclaw_sessions s
          LEFT JOIN agents a ON a.id = s.agent_id
          LEFT JOIN tasks t ON t.id = s.task_id
          WHERE COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) IN (${workspaceIds
            .map(() => '?')
            .join(', ')})
        `,
        workspaceIds,
      ).map((row) => row.openclaw_session_id),
    );
    const sessions = (await client.listSessions()).filter((session) =>
      accessibleSessionIds.has(session.id),
    );
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to list runtime sessions:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

// POST /api/openclaw/sessions - Create a new runtime session
export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const body = await request.json();
    const { channel, peer } = body;
    const workspaceId = normalizeWorkspaceId(body.workspace_id);

    if (!channel) {
      return NextResponse.json({ error: 'channel is required' }, { status: 400 });
    }
    if (!workspaceId || !hasWorkspaceAccess(userContext, workspaceId)) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }

    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to Mission Control runtime' },
          { status: 503 },
        );
      }
    }

    const session = await client.createSession(channel, peer, workspaceId);
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error('Failed to create runtime session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
