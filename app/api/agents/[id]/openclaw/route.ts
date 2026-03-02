import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import type { Agent, OpenClawSession } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/agents/[id]/openclaw - Get the agent's runtime session
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [id, 'active'],
    );

    if (!session) {
      return NextResponse.json({ linked: false, session: null });
    }

    return NextResponse.json({ linked: true, session });
  } catch (error) {
    console.error('Failed to get runtime session:', error);
    return NextResponse.json({ error: 'Failed to get runtime session' }, { status: 500 });
  }
}

// POST /api/agents/[id]/openclaw - Link agent to runtime (creates session)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Check if already linked
    const existingSession = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [id, 'active'],
    );
    if (existingSession) {
      return NextResponse.json(
        { error: 'Agent is already linked to a runtime session', session: existingSession },
        { status: 409 },
      );
    }

    // Connect to integrated runtime
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

    // Runtime creates sessions automatically when messages are sent
    // Just verify connection works by listing sessions
    try {
      await client.listSessions();
    } catch (err) {
      console.error('Failed to verify runtime connection:', err);
      return NextResponse.json(
        { error: 'Connected but failed to communicate with Mission Control runtime' },
        { status: 503 },
      );
    }

    // Store the link in our database - session ID will be set when first message is sent
    // For now, use agent name as the session identifier
    const sessionId = crypto.randomUUID();
    const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
    const now = new Date().toISOString();

    run(
      `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, id, openclawSessionId, 'mission-control', 'active', now, now],
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'agent_status_changed',
        id,
        `${agent.name} linked to Mission Control runtime`,
        now,
      ],
    );

    const session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [
      sessionId,
    ]);

    return NextResponse.json({ linked: true, session }, { status: 201 });
  } catch (error) {
    console.error('Failed to link agent to runtime:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/agents/[id]/openclaw - Unlink agent from runtime
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const existingSession = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [id, 'active'],
    );

    if (!existingSession) {
      return NextResponse.json(
        { error: 'Agent is not linked to a runtime session' },
        { status: 404 },
      );
    }

    // Mark the session as inactive
    const now = new Date().toISOString();
    run('UPDATE openclaw_sessions SET status = ?, updated_at = ? WHERE id = ?', [
      'inactive',
      now,
      existingSession.id,
    ]);

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'agent_status_changed',
        id,
        `${agent.name} unlinked from Mission Control runtime`,
        now,
      ],
    );

    return NextResponse.json({ linked: false, success: true });
  } catch (error) {
    console.error('Failed to unlink agent from runtime:', error);
    return NextResponse.json({ error: 'Failed to unlink agent from runtime' }, { status: 500 });
  }
}
