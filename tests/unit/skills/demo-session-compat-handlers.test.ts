import { describe, expect, it, vi } from 'vitest';

const callMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openclaw/client', () => ({
  getOpenClawClient: () => ({ call: callMock }),
}));

import {
  agentsListHandler,
  sessionStatusHandler,
  sessionsHistoryHandler,
  sessionsListHandler,
  sessionsSendHandler,
  sessionsSpawnHandler,
} from '@/server/skills/handlers/sessionCompat';

describe('session/agent compat handlers', () => {
  it('maps sessions and agents tool calls to OpenClaw client methods', async () => {
    callMock.mockReset();
    callMock.mockImplementation(async (method: string) => {
      if (method === 'agents.list') return [{ id: 'agent-1', name: 'Agent 1' }];
      if (method === 'sessions.list') return [{ id: 'agent:main:s-1', status: 'active' }];
      if (method === 'sessions.history') return [{ role: 'assistant', content: 'ok' }];
      if (method === 'sessions.create') return { id: 'agent:main:new-session', status: 'active' };
      if (method === 'sessions.send') return { ok: true };
      return {};
    });

    const agents = (await agentsListHandler({})) as { agents: Array<{ id: string }> };
    expect(agents.agents[0]?.id).toBe('agent-1');

    const listed = (await sessionsListHandler({ limit: 1 })) as { sessions: Array<{ id: string }> };
    expect(listed.sessions[0]?.id).toContain('s-1');

    const history = (await sessionsHistoryHandler({ sessionId: 'agent:main:s-1' })) as {
      messages: Array<{ content: string }>;
    };
    expect(history.messages[0]?.content).toBe('ok');

    const sent = (await sessionsSendHandler({ sessionId: 'agent:main:s-1', content: 'hello' })) as {
      ok: boolean;
    };
    expect(sent.ok).toBe(true);

    const spawned = (await sessionsSpawnHandler({ label: 'demo', task: 'run checks' })) as {
      session: { id: string };
      dispatched: boolean;
    };
    expect(spawned.session.id).toContain('new-session');
    expect(spawned.dispatched).toBe(true);

    const status = (await sessionStatusHandler({
      sessionId: 'agent:main:s-1',
      includeHistory: true,
    })) as {
      session: { id: string };
      history?: unknown[];
    };
    expect(status.session.id).toContain('s-1');
    expect(Array.isArray(status.history)).toBe(true);

    expect(callMock).toHaveBeenCalledWith('agents.list', {});
    expect(callMock).toHaveBeenCalledWith('sessions.list', {});
    expect(callMock).toHaveBeenCalledWith('sessions.history', { session_id: 'agent:main:s-1' });
    expect(callMock).toHaveBeenCalledWith('sessions.send', {
      session_id: 'agent:main:s-1',
      content: 'hello',
    });
  });
});
