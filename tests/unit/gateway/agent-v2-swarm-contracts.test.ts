import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type { RequestFrame } from '@/server/gateway/protocol';

function makeClient(userId = 'user-v2'): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as GatewayClient['socket'],
    connId: 'conn-v2',
    userId,
    protocol: 'v2',
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

function req(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-contract',
): RequestFrame {
  return { type: 'req', id, method, params };
}

const SOURCE_SWARM = {
  id: 'swarm-src',
  conversationId: 'conv-src',
  userId: 'user-v2',
  sessionId: null,
  title: 'Source Swarm',
  task: 'Source task',
  leadPersonaId: 'persona-1',
  units: [
    { personaId: 'persona-1', role: 'lead' },
    { personaId: 'persona-2', role: 'specialist' },
  ],
  status: 'completed',
  currentPhase: 'result',
  consensusScore: 85,
  holdFlag: false,
  artifact: '**[Agent]:** Result text.',
  artifactHistory: ['snapshot-1'],
  friction: { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: 'now' },
  lastSeq: 10,
  currentDeployCommandId: null,
  searchEnabled: false,
  swarmTemplate: 'brainstorm',
  pauseBetweenPhases: true,
  phaseBuffer: [],
  createdAt: 'now',
  updatedAt: 'now',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Shared mock setup for all tests in this file. */
function setupMocks(overrides?: {
  getAgentRoomSwarm?: ReturnType<typeof vi.fn>;
  createAgentRoomSwarm?: ReturnType<typeof vi.fn>;
  updateAgentRoomSwarm?: ReturnType<typeof vi.fn>;
}) {
  vi.stubEnv('AGENT_ROOM_ENABLED', 'true');

  const getAgentRoomSwarm = overrides?.getAgentRoomSwarm ?? vi.fn(() => ({ ...SOURCE_SWARM }));
  const createAgentRoomSwarm =
    overrides?.createAgentRoomSwarm ??
    vi.fn((input: Record<string, unknown>) => ({
      id: 'swarm-new',
      ...input,
      createdAt: 'now',
      updatedAt: 'now',
    }));
  const updateAgentRoomSwarm =
    overrides?.updateAgentRoomSwarm ??
    vi.fn((_id: string, _uid: string, patch: Record<string, unknown>) => ({
      ...SOURCE_SWARM,
      ...patch,
      status: patch.status ?? SOURCE_SWARM.status,
      updatedAt: 'later',
    }));

  vi.doMock('../../../src/server/channels/messages/runtime', () => ({
    getMessageRepository: vi.fn(() => ({
      createAgentRoomSwarm,
      listAgentRoomSwarms: vi.fn(() => []),
      getAgentRoomSwarm,
      updateAgentRoomSwarm,
      deleteAgentRoomSwarm: vi.fn(() => true),
    })),
    getMessageService: vi.fn(() => ({
      getConversation: vi.fn(() => ({ id: 'conv-1', personaId: null })),
      isAgentRoomConversation: vi.fn(() => true),
      getOrCreateConversation: vi.fn(() => ({ id: 'conv-new', personaId: null })),
      setPersonaId: vi.fn(),
    })),
  }));
  vi.doMock('../../../src/server/personas/personaRepository', () => ({
    getPersonaRepository: () => ({
      getPersona: vi.fn((id: string) => ({ id, name: id })),
    }),
  }));
  vi.doMock('../../../src/server/agent-v2/runtime', () => ({
    getAgentV2SessionManager: () => ({
      startSession: vi.fn(),
      enqueueInput: vi.fn(),
      enqueueSteer: vi.fn(),
      enqueueFollowUp: vi.fn(),
      enqueueApprovalResponse: vi.fn(),
      enqueueAbort: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      replaySessionEvents: vi.fn(),
    }),
  }));
  vi.doMock('../../../src/server/gateway/broadcast', () => ({
    broadcastToUser: vi.fn(),
  }));

  return { getAgentRoomSwarm, createAgentRoomSwarm, updateAgentRoomSwarm };
}

async function loadDispatcher() {
  const { dispatchMethod } = await import('@/server/gateway/method-router');
  await import('@/server/gateway/methods/agent-v2/registerMethods');
  return dispatchMethod;
}

async function dispatch(method: string, params?: Record<string, unknown>, client?: GatewayClient) {
  const dispatchMethod = await loadDispatcher();
  const sent: unknown[] = [];
  await dispatchMethod(
    req(method, params),
    client ?? makeClient(),
    (frame) => sent.push(frame),
    'v2',
  );
  return sent[0] as Record<string, unknown>;
}

describe('gateway swarm contract — server-only field guard', () => {
  it('rejects swarm.update that sets artifact', async () => {
    vi.resetModules();
    setupMocks();

    const result = await dispatch('agent.v2.swarm.update', {
      id: 'swarm-1',
      artifact: 'hacked artifact',
    });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects swarm.update that sets artifactHistory', async () => {
    vi.resetModules();
    setupMocks();

    const result = await dispatch('agent.v2.swarm.update', {
      id: 'swarm-1',
      artifactHistory: ['fake'],
    });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects swarm.update that sets friction', async () => {
    vi.resetModules();
    setupMocks();

    const result = await dispatch('agent.v2.swarm.update', {
      id: 'swarm-1',
      friction: { level: 'high' },
    });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('allows swarm.update with valid non-server fields', async () => {
    vi.resetModules();
    const { updateAgentRoomSwarm } = setupMocks();

    const result = await dispatch('agent.v2.swarm.update', {
      id: 'swarm-1',
      title: 'New title',
      holdFlag: true,
    });
    expect(result).toMatchObject({ type: 'res', ok: true });
    expect(updateAgentRoomSwarm).toHaveBeenCalled();
  });
});

describe('gateway swarm contract — speakerOverride (C2)', () => {
  it('accepts speakerOverride and injects it into phaseBuffer', async () => {
    vi.resetModules();
    const { updateAgentRoomSwarm } = setupMocks();

    const result = await dispatch('agent.v2.swarm.update', {
      id: 'swarm-1',
      speakerOverride: 'persona-2',
    });
    expect(result).toMatchObject({ type: 'res', ok: true });
    // The patch should include phaseBuffer with speakerOverride entry
    const patchArg = updateAgentRoomSwarm.mock.calls[0][2] as Record<string, unknown>;
    const buffer = patchArg.phaseBuffer as Array<Record<string, unknown>>;
    expect(buffer).toBeDefined();
    expect(buffer.some((e) => e.type === 'speakerOverride' && e.personaId === 'persona-2')).toBe(
      true,
    );
  });
});

describe('gateway swarm contract — swarm.fork (C4)', () => {
  it('creates a fork from an existing swarm', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    const result = await dispatch('agent.v2.swarm.fork', {
      id: 'swarm-src',
    });
    expect(result).toMatchObject({ type: 'res', ok: true });
    const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.forkedFrom).toBe('swarm-src');

    // Verify inherited fields
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.task).toBe('Source task');
    expect(createCall.leadPersonaId).toBe('persona-1');
    expect(createCall.status).toBe('idle');
    expect(createCall.consensusScore).toBe(0);
    expect(createCall.artifact).toBe('**[Agent]:** Result text.');
  });

  it('fork uses custom title when provided', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    await dispatch('agent.v2.swarm.fork', {
      id: 'swarm-src',
      title: 'Custom Fork Title',
    });
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.title).toBe('Custom Fork Title');
  });

  it('fork defaults title to "<parent> (Fork)"', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    await dispatch('agent.v2.swarm.fork', { id: 'swarm-src' });
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.title).toBe('Source Swarm (Fork)');
  });

  it('fork returns NOT_FOUND when source does not exist', async () => {
    vi.resetModules();
    setupMocks({ getAgentRoomSwarm: vi.fn(() => null) });

    const result = await dispatch('agent.v2.swarm.fork', { id: 'missing' });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('gateway swarm contract — swarm.chain (C10)', () => {
  it('creates a chained swarm with parent artifact as context', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    const result = await dispatch('agent.v2.swarm.chain', {
      sourceSwarmId: 'swarm-src',
      task: 'Continue the analysis',
    });
    expect(result).toMatchObject({ type: 'res', ok: true });
    const payload = (result as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.chainedFrom).toBe('swarm-src');

    // Verify task includes parent context
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    const taskStr = createCall.task as string;
    expect(taskStr).toContain('Continue the analysis');
    expect(taskStr).toContain('Context from previous swarm');
    expect(taskStr).toContain('**[Agent]:** Result text.');
  });

  it('chain starts at analysis phase with empty artifact', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    await dispatch('agent.v2.swarm.chain', {
      sourceSwarmId: 'swarm-src',
      task: 'New task',
    });
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.currentPhase).toBe('analysis');
    expect(createCall.artifact).toBe('');
    expect(createCall.status).toBe('idle');
  });

  it('chain inherits units from parent when not provided', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    await dispatch('agent.v2.swarm.chain', {
      sourceSwarmId: 'swarm-src',
      task: 'New task',
    });
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    const units = createCall.units as Array<{ personaId: string; role: string }>;
    expect(units).toHaveLength(2);
    expect(units[0].personaId).toBe('persona-1');
    expect(createCall.leadPersonaId).toBe('persona-1');
  });

  it('chain returns NOT_FOUND when source does not exist', async () => {
    vi.resetModules();
    setupMocks({ getAgentRoomSwarm: vi.fn(() => null) });

    const result = await dispatch('agent.v2.swarm.chain', {
      sourceSwarmId: 'missing',
      task: 'New task',
    });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('chain uses custom title when provided', async () => {
    vi.resetModules();
    const { createAgentRoomSwarm } = setupMocks();

    await dispatch('agent.v2.swarm.chain', {
      sourceSwarmId: 'swarm-src',
      task: 'Chain task',
      title: 'My Chain Swarm',
    });
    const createCall = createAgentRoomSwarm.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.title).toBe('My Chain Swarm');
  });
});

describe('gateway swarm contract — swarm.deploy', () => {
  it('deploys an idle swarm to running with phase reset', async () => {
    vi.resetModules();
    const idleSwarm = { ...SOURCE_SWARM, status: 'idle', currentPhase: 'result' };
    const { updateAgentRoomSwarm } = setupMocks({
      getAgentRoomSwarm: vi.fn(() => ({ ...idleSwarm })),
    });

    const result = await dispatch('agent.v2.swarm.deploy', { id: 'swarm-src' });
    expect(result).toMatchObject({ type: 'res', ok: true });

    const patchArg = updateAgentRoomSwarm.mock.calls[0][2] as Record<string, unknown>;
    expect(patchArg.status).toBe('running');
    expect(patchArg.holdFlag).toBe(false);
    // Fresh deploy resets to analysis
    expect(patchArg.currentPhase).toBe('analysis');
  });

  it('resumes a held swarm without resetting phase', async () => {
    vi.resetModules();
    const holdSwarm = { ...SOURCE_SWARM, status: 'hold', currentPhase: 'critique' };
    const { updateAgentRoomSwarm } = setupMocks({
      getAgentRoomSwarm: vi.fn(() => ({ ...holdSwarm })),
    });

    const result = await dispatch('agent.v2.swarm.deploy', { id: 'swarm-src' });
    expect(result).toMatchObject({ type: 'res', ok: true });

    const patchArg = updateAgentRoomSwarm.mock.calls[0][2] as Record<string, unknown>;
    expect(patchArg.status).toBe('running');
    // Resume: does NOT reset phase
    expect(patchArg.currentPhase).toBeUndefined();
  });

  it('rejects deploy when swarm is already running', async () => {
    vi.resetModules();
    const runningSwarm = { ...SOURCE_SWARM, status: 'running' };
    setupMocks({
      getAgentRoomSwarm: vi.fn(() => ({ ...runningSwarm })),
    });

    const result = await dispatch('agent.v2.swarm.deploy', { id: 'swarm-src' });
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects deploy for completed swarm', async () => {
    vi.resetModules();
    setupMocks();

    const result = await dispatch('agent.v2.swarm.deploy', { id: 'swarm-src' });
    // SOURCE_SWARM has status 'completed' which is not in resumable list
    expect(result).toMatchObject({
      type: 'res',
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});

