import { NextResponse } from 'next/server';
import { queryAll, run } from '@/lib/db';
import { withUserContext } from '../_shared/withUserContext';
import type { Event } from '@/lib/types';
import {
  canAccessAgent,
  canAccessTask,
  getAccessibleWorkspaceIds,
  getAgentWorkspaceId,
  getTaskWorkspaceId,
} from '@/server/auth/workspaceAccess';

// GET /api/events - List events (live feed)
export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const since = searchParams.get('since'); // ISO timestamp for polling
    const workspaceIds = getAccessibleWorkspaceIds(userContext);
    if (workspaceIds.length === 0) {
      return NextResponse.json([]);
    }

    let sql = `
      SELECT e.*, a.name as agent_name, a.avatar_emoji as agent_emoji, t.title as task_title
      FROM events e
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN tasks t ON e.task_id = t.id
      WHERE (
        (e.task_id IS NULL AND e.agent_id IS NULL)
        OR t.workspace_id IN (${workspaceIds.map(() => '?').join(', ')})
        OR a.workspace_id IN (${workspaceIds.map(() => '?').join(', ')})
      )
    `;
    const params: unknown[] = [...workspaceIds, ...workspaceIds];

    if (since) {
      sql += ' AND e.created_at > ?';
      params.push(since);
    }

    sql += ' ORDER BY e.created_at DESC LIMIT ?';
    params.push(limit);

    const events = queryAll<
      Event & { agent_name?: string; agent_emoji?: string; task_title?: string }
    >(sql, params);

    // Transform to include nested info
    const transformedEvents = events.map((event) => ({
      ...event,
      agent: event.agent_id
        ? {
            id: event.agent_id,
            name: event.agent_name,
            avatar_emoji: event.agent_emoji,
          }
        : undefined,
      task: event.task_id
        ? {
            id: event.task_id,
            title: event.task_title,
          }
        : undefined,
    }));

    return NextResponse.json(transformedEvents);
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
});

// POST /api/events - Create a manual event
export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const body = await request.json();

    if (!body.type || !body.message) {
      return NextResponse.json({ error: 'Type and message are required' }, { status: 400 });
    }

    const agentId = typeof body.agent_id === 'string' ? body.agent_id : null;
    const taskId = typeof body.task_id === 'string' ? body.task_id : null;
    if (agentId && !canAccessAgent(userContext, agentId)) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    if (taskId && !canAccessTask(userContext, taskId)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    if (agentId && taskId) {
      const agentWorkspaceId = getAgentWorkspaceId(agentId);
      const taskWorkspaceId = getTaskWorkspaceId(taskId);
      if (!agentWorkspaceId || agentWorkspaceId !== taskWorkspaceId) {
        return NextResponse.json({ error: 'Agent and task workspace mismatch' }, { status: 400 });
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.type,
        agentId,
        taskId,
        body.message,
        body.metadata ? JSON.stringify(body.metadata) : null,
        now,
      ],
    );

    return NextResponse.json(
      { id, type: body.type, message: body.message, created_at: now },
      { status: 201 },
    );
  } catch (error) {
    console.error('Failed to create event:', error);
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
});
