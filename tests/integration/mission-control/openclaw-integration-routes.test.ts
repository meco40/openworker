import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control OpenClaw integration routes', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousGatewayUrl: string | undefined;
  let previousGatewayToken: string | undefined;
  let previousMissionControlUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();

    previousDatabasePath = process.env.DATABASE_PATH;
    previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    previousMissionControlUrl = process.env.MISSION_CONTROL_URL;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openclaw-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.MISSION_CONTROL_URL;
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();

    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousGatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    }
    if (previousGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    }
    if (previousMissionControlUrl === undefined) {
      delete process.env.MISSION_CONTROL_URL;
    } else {
      process.env.MISSION_CONTROL_URL = previousMissionControlUrl;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('reports integrated gateway as connected by default', async () => {
    const { GET } = await import('../../../app/api/openclaw/status/route');

    const response = await GET();
    const payload = (await response.json()) as {
      connected: boolean;
      gateway_url?: string;
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.connected).toBe(true);
    expect(payload.gateway_url).toContain('/ws');
    expect(payload.gateway_url).not.toContain('18789');
    expect(payload.error).toBeUndefined();
  });

  it('links an agent to OpenClaw without requiring an external gateway', async () => {
    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();

    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['default', 'Default Workspace', 'default', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['agent-1', 'Mission Lead', 'Orchestrator', 'standby', 1, 'default', 'local', now, now],
    );

    const route = await import('../../../app/api/agents/[id]/openclaw/route');
    const response = await route.POST(
      new NextRequest('http://localhost/api/agents/agent-1/openclaw'),
      {
        params: Promise.resolve({ id: 'agent-1' }),
      },
    );
    const payload = (await response.json()) as {
      linked?: boolean;
      session?: { openclaw_session_id?: string };
      error?: string;
    };

    expect(response.status).toBe(201);
    expect(payload.linked).toBe(true);
    expect(payload.session?.openclaw_session_id).toBe('mission-control-mission-lead');

    const linkedSession = queryOne<{ id: string }>(
      'SELECT id FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      ['agent-1', 'active'],
    );
    expect(linkedSession).toBeTruthy();
  });
});
