import { NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { withUserContext } from '../../_shared/withUserContext';
import type { Agent, DiscoveredAgent } from '@/lib/types';
import { hasWorkspaceAccess, normalizeWorkspaceId } from '@/server/auth/workspaceAccess';

// This route must always be dynamic - it queries live runtime state + DB
export const dynamic = 'force-dynamic';

// Shape of an agent returned by the integrated runtime `agents.list` call
interface GatewayAgent {
  id?: string;
  name?: string;
  label?: string;
  model?: string;
  channel?: string;
  status?: string;
  [key: string]: unknown;
}

// GET /api/agents/discover - Discover existing agents from the runtime registry
export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const workspaceId = normalizeWorkspaceId(
      new URL(request.url).searchParams.get('workspace_id') || 'default',
    );
    if (!workspaceId || !hasWorkspaceAccess(userContext, workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
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

    let gatewayAgents: GatewayAgent[];
    try {
      gatewayAgents = (await client.listAgents()) as GatewayAgent[];
    } catch (err) {
      console.error('Failed to list agents from runtime registry:', err);
      return NextResponse.json(
        { error: 'Failed to list agents from runtime registry' },
        { status: 502 },
      );
    }

    if (!Array.isArray(gatewayAgents)) {
      return NextResponse.json(
        { error: 'Unexpected response from runtime agents.list' },
        { status: 502 },
      );
    }

    // Only expose import state for the requested workspace.
    const existingAgents = queryAll<Agent>(
      `SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL AND workspace_id = ?`,
      [workspaceId],
    );
    const importedGatewayIds = new Map(existingAgents.map((a) => [a.gateway_agent_id, a.id]));

    // Map gateway agents to our DiscoveredAgent type
    const discovered: DiscoveredAgent[] = gatewayAgents.map((ga) => {
      const gatewayId = ga.id || ga.name || '';
      const alreadyImported = importedGatewayIds.has(gatewayId);
      return {
        id: gatewayId,
        name: ga.name || ga.label || gatewayId,
        label: ga.label,
        model: ga.model,
        channel: ga.channel,
        status: ga.status,
        already_imported: alreadyImported,
        existing_agent_id: alreadyImported ? importedGatewayIds.get(gatewayId) : undefined,
      };
    });

    return NextResponse.json({
      agents: discovered,
      total: discovered.length,
      already_imported: discovered.filter((a) => a.already_imported).length,
    });
  } catch (error) {
    console.error('Failed to discover agents:', error);
    return NextResponse.json(
      { error: 'Failed to discover agents from runtime registry' },
      { status: 500 },
    );
  }
});
