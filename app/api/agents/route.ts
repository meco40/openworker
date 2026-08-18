import { NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import { CreateAgentSchema } from '@/lib/validation';
import type { Agent } from '@/lib/types';
import { parseJsonBody } from '../_shared/parseJsonBody';
import { withUserContext } from '../_shared/withUserContext';
import {
  getAccessibleWorkspaceIds,
  hasWorkspaceAccess,
  normalizeWorkspaceId,
} from '@/server/auth/workspaceAccess';

export const runtime = 'nodejs';

export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const workspaceId = new URL(request.url).searchParams.get('workspace_id');

    if (workspaceId && !hasWorkspaceAccess(userContext, workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const accessibleWorkspaceIds = workspaceId
      ? [workspaceId]
      : getAccessibleWorkspaceIds(userContext);
    const agents = accessibleWorkspaceIds.length
      ? queryAll<Agent>(
          `SELECT * FROM agents WHERE workspace_id IN (${accessibleWorkspaceIds
            .map(() => '?')
            .join(', ')}) ORDER BY is_master DESC, name ASC`,
          accessibleWorkspaceIds,
        )
      : [];

    return NextResponse.json(agents);
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
});

export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const parsed = await parseJsonBody(request, CreateAgentSchema);
    if (!parsed.ok) {
      return parsed.response as Response;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const body = parsed.data;
    const workspaceId = normalizeWorkspaceId(body.workspace_id || 'default');
    if (!workspaceId || !hasWorkspaceAccess(userContext, workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    run(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name.trim(),
        body.role.trim(),
        body.description?.trim() || null,
        body.avatar_emoji?.trim() || '🤖',
        body.is_master ? 1 : 0,
        workspaceId,
        body.soul_md || null,
        body.user_md || null,
        body.agents_md || null,
        body.model || null,
        now,
        now,
      ],
    );

    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), 'agent_joined', id, `${body.name} joined the team`, now],
    );

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
});
