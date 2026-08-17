import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type { RespondFn } from '@/server/gateway/method-router';

const mocks = vi.hoisted(() => ({
  registerMethod: vi.fn(),
  getMessageService: vi.fn(),
  getSwarmRepository: vi.fn(),
  broadcastToUser: vi.fn(),
  getPersonaRepository: vi.fn(),
  getMessageRepository: vi.fn(),
}));

vi.mock('@/server/gateway/method-router', () => ({
  registerMethod: mocks.registerMethod,
}));

vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageService: mocks.getMessageService,
  getMessageRepository: mocks.getMessageRepository,
}));

vi.mock('@/server/gateway/broadcast', () => ({
  broadcastToUser: mocks.broadcastToUser,
}));

vi.mock('@/server/gateway/events', () => ({
  GatewayEvents: { AGENT_ROOM_SWARM: 'agent.room.swarm' },
}));

vi.mock('@/server/personas/personaRepository', () => ({
  getPersonaRepository: mocks.getPersonaRepository,
}));

type Handler = (
  params: Record<string, unknown>,
  client: GatewayClient,
  respond: RespondFn,
) => Promise<void> | void;

function makeClient(userId = 'user-1'): GatewayClient {
  return { userId } as GatewayClient;
}

function makeRespond(): { respond: RespondFn; responses: unknown[] } {
  const responses: unknown[] = [];
  const respond: RespondFn = (response) => {
    responses.push(response);
  };
  return { respond, responses };
}

function makeSwarm(overrides: Record<string, unknown> = {}) {
  return {
    id: 'swarm-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    title: 'Test Swarm',
    task: 'Test task',
    leadPersonaId: 'persona-1',
    units: [{ personaId: 'persona-1', role: 'lead' }],
    currentPhase: 'analysis',
    status: 'idle',
    consensusScore: 0,
    holdFlag: false,
    artifact: '',
    artifactHistory: [],
    friction: { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: '' },
    lastSeq: 0,
    searchEnabled: false,
    swarmTemplate: null,
    pauseBetweenPhases: false,
    phaseBuffer: [],
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

async function importModule() {
  await import('@/server/gateway/methods/agent-v2/registerSwarmMethods');
}

describe('agent.v2.swarm methods', () => {
  const registered = new Map<string, Handler>();

  beforeEach(() => {
    vi.clearAllMocks();
    registered.clear();
    mocks.registerMethod.mockImplementation((method: string, handler: Handler) => {
      registered.set(method, handler);
    });
    mocks.getPersonaRepository.mockReturnValue({
      getPersona: (id: string) => (id === 'persona-1' || id === 'persona-2' ? { id } : null),
    });
    mocks.getMessageRepository.mockReturnValue({
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('registers all swarm methods', async () => {
    await importModule();
    expect(registered.has('agent.v2.swarm.create')).toBe(true);
    expect(registered.has('agent.v2.swarm.list')).toBe(true);
    expect(registered.has('agent.v2.swarm.get')).toBe(true);
    expect(registered.has('agent.v2.swarm.update')).toBe(true);
    expect(registered.has('agent.v2.swarm.delete')).toBe(true);
    expect(registered.has('agent.v2.swarm.fork')).toBe(true);
    expect(registered.has('agent.v2.swarm.chain')).toBe(true);
    expect(registered.has('agent.v2.swarm.deploy')).toBe(true);
  });

  it('creates a swarm with a new conversation', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(() => ({ id: 'conv-new' })),
      setPersonaId: vi.fn(),
      getConversation: vi.fn(),
      isAgentRoomConversation: vi.fn(),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(() => makeSwarm({ id: 'swarm-new' })),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.create')!;
    const { respond, responses } = makeRespond();

    await handler(
      {
        title: 'New Swarm',
        task: 'Do something',
        leadPersonaId: 'persona-1',
        units: [
          { personaId: 'persona-1', role: 'lead' },
          { personaId: 'persona-2', role: 'member' },
        ],
      },
      makeClient(),
      respond,
    );

    expect(messageService.getOrCreateConversation).toHaveBeenCalled();
    expect(repo.createAgentRoomSwarm).toHaveBeenCalled();
    expect(responses.length).toBe(1);
    expect(mocks.broadcastToUser).toHaveBeenCalled();
  });

  it('creates a swarm with an existing agent-room conversation', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(),
      setPersonaId: vi.fn(),
      getConversation: vi.fn(() => ({ id: 'conv-existing' })),
      isAgentRoomConversation: vi.fn(() => true),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(() => makeSwarm({ id: 'swarm-existing' })),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.create')!;
    const { respond } = makeRespond();

    await handler(
      {
        title: 'Existing Swarm',
        task: 'Do something',
        leadPersonaId: 'persona-1',
        units: [
          { personaId: 'persona-1', role: 'lead' },
          { personaId: 'persona-2', role: 'member' },
        ],
        conversationId: 'conv-existing',
      },
      makeClient(),
      respond,
    );

    expect(messageService.getConversation).toHaveBeenCalledWith('conv-existing', 'user-1');
    expect(messageService.isAgentRoomConversation).toHaveBeenCalledWith('conv-existing', 'user-1');
    expect(repo.createAgentRoomSwarm).toHaveBeenCalled();
  });

  it('rejects a non-agent-room conversation on create', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(),
      setPersonaId: vi.fn(),
      getConversation: vi.fn(() => ({ id: 'conv-regular' })),
      isAgentRoomConversation: vi.fn(() => false),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.create')!;
    const { respond } = makeRespond();

    await expect(
      handler(
        {
          title: 'Bad Swarm',
          task: 'Do something',
          leadPersonaId: 'persona-1',
          units: [
            { personaId: 'persona-1', role: 'lead' },
            { personaId: 'persona-2', role: 'member' },
          ],
          conversationId: 'conv-regular',
        },
        makeClient(),
        respond,
      ),
    ).rejects.toThrow('Conversation must be dedicated to Agent Room sessions.');
  });

  it('lists swarms with default limit', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(() => [makeSwarm()]),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.list')!;
    const { respond, responses } = makeRespond();

    await handler({}, makeClient(), respond);

    expect(repo.listAgentRoomSwarms).toHaveBeenCalledWith('user-1', 100);
    expect(responses[0]).toEqual({ swarms: [makeSwarm()] });
  });

  it('lists swarms with custom limit', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(() => []),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.list')!;
    const { respond } = makeRespond();

    await handler({ limit: 5 }, makeClient(), respond);

    expect(repo.listAgentRoomSwarms).toHaveBeenCalledWith('user-1', 5);
  });

  it('gets a swarm by id', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm()),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.get')!;
    const { respond, responses } = makeRespond();

    await handler({ id: 'swarm-1' }, makeClient(), respond);

    expect(repo.getAgentRoomSwarm).toHaveBeenCalledWith('swarm-1', 'user-1');
    expect(responses[0]).toEqual({ swarm: makeSwarm() });
  });

  it('throws when swarm not found on get', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => null),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.get')!;
    const { respond } = makeRespond();

    await expect(handler({ id: 'missing' }, makeClient(), respond)).rejects.toThrow(
      'Swarm not found.',
    );
  });

  it('updates a swarm with valid fields', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm()),
      updateAgentRoomSwarm: vi.fn(() => makeSwarm({ title: 'Updated' })),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond, responses } = makeRespond();

    await handler(
      { id: 'swarm-1', title: 'Updated', status: 'running', currentPhase: 'research' },
      makeClient(),
      respond,
    );

    expect(repo.updateAgentRoomSwarm).toHaveBeenCalled();
    expect(responses[0]).toEqual({ swarm: makeSwarm({ title: 'Updated' }) });
  });

  it('rejects server-only fields on update', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond } = makeRespond();

    await expect(
      handler({ id: 'swarm-1', artifact: 'should fail' }, makeClient(), respond),
    ).rejects.toThrow('managed by the orchestrator');
  });

  it('rejects invalid status on update', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond } = makeRespond();

    await expect(
      handler({ id: 'swarm-1', status: 'invalid-status' }, makeClient(), respond),
    ).rejects.toThrow('Invalid swarm status.');
  });

  it('rejects invalid phase on update', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond } = makeRespond();

    await expect(
      handler({ id: 'swarm-1', currentPhase: 'invalid-phase' }, makeClient(), respond),
    ).rejects.toThrow('Invalid swarm phase.');
  });

  it('rejects invalid consensusScore on update', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond } = makeRespond();

    await expect(
      handler({ id: 'swarm-1', consensusScore: 150 }, makeClient(), respond),
    ).rejects.toThrow('consensusScore must be between 0 and 100.');
  });

  it('rejects invalid lastSeq on update', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.update')!;
    const { respond } = makeRespond();

    await expect(handler({ id: 'swarm-1', lastSeq: -1 }, makeClient(), respond)).rejects.toThrow(
      'lastSeq must be a non-negative number.',
    );
  });

  it('deletes a swarm', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(() => true),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.delete')!;
    const { respond, responses } = makeRespond();

    await handler({ id: 'swarm-1' }, makeClient(), respond);

    expect(repo.deleteAgentRoomSwarm).toHaveBeenCalledWith('swarm-1', 'user-1');
    expect(responses[0]).toEqual({ deleted: true });
  });

  it('throws when swarm not found on delete', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(() => false),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.delete')!;
    const { respond } = makeRespond();

    await expect(handler({ id: 'missing' }, makeClient(), respond)).rejects.toThrow(
      'Swarm not found.',
    );
  });

  it('forks a swarm', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(() => ({ id: 'conv-fork' })),
      setPersonaId: vi.fn(),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(() => makeSwarm({ id: 'swarm-fork' })),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm()),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.fork')!;
    const { respond, responses } = makeRespond();

    await handler({ id: 'swarm-1' }, makeClient(), respond);

    expect(repo.createAgentRoomSwarm).toHaveBeenCalled();
    expect(responses[0]).toEqual({ swarm: makeSwarm({ id: 'swarm-fork' }), forkedFrom: 'swarm-1' });
  });

  it('throws when source swarm not found on fork', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => null),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.fork')!;
    const { respond } = makeRespond();

    await expect(handler({ id: 'missing' }, makeClient(), respond)).rejects.toThrow(
      'Source swarm not found.',
    );
  });

  it('chains a swarm with inherited units', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(() => ({ id: 'conv-chain' })),
      setPersonaId: vi.fn(),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(() => makeSwarm({ id: 'swarm-chain' })),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm()),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.chain')!;
    const { respond, responses } = makeRespond();

    await handler({ sourceSwarmId: 'swarm-1', task: 'Chain task' }, makeClient(), respond);

    expect(repo.createAgentRoomSwarm).toHaveBeenCalled();
    expect(responses[0]).toEqual({
      swarm: makeSwarm({ id: 'swarm-chain' }),
      chainedFrom: 'swarm-1',
    });
  });

  it('chains a swarm with custom units', async () => {
    const messageService = {
      getOrCreateConversation: vi.fn(() => ({ id: 'conv-chain-2' })),
      setPersonaId: vi.fn(),
    };
    const repo = {
      createAgentRoomSwarm: vi.fn(() => makeSwarm({ id: 'swarm-chain-2' })),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm()),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageService.mockReturnValue(messageService);
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.chain')!;
    const { respond } = makeRespond();

    await handler(
      {
        sourceSwarmId: 'swarm-1',
        task: 'Chain task',
        units: [
          { personaId: 'persona-1', role: 'lead' },
          { personaId: 'persona-2', role: 'member' },
        ],
        leadPersonaId: 'persona-1',
      },
      makeClient(),
      respond,
    );

    expect(repo.createAgentRoomSwarm).toHaveBeenCalled();
  });

  it('deploys a swarm from idle status', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm({ status: 'idle' })),
      updateAgentRoomSwarm: vi.fn(() => makeSwarm({ status: 'running' })),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.deploy')!;
    const { respond, responses } = makeRespond();

    await handler({ id: 'swarm-1' }, makeClient(), respond);

    expect(repo.updateAgentRoomSwarm).toHaveBeenCalled();
    expect(responses[0]).toEqual({ swarm: makeSwarm({ status: 'running' }) });
  });

  it('deploys a swarm from hold status without resetting phase', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm({ status: 'hold', currentPhase: 'research' })),
      updateAgentRoomSwarm: vi.fn(() => makeSwarm({ status: 'running', currentPhase: 'research' })),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.deploy')!;
    const { respond } = makeRespond();

    await handler({ id: 'swarm-1' }, makeClient(), respond);

    expect(repo.updateAgentRoomSwarm).toHaveBeenCalled();
  });

  it('rejects deploy when swarm is not resumable', async () => {
    const repo = {
      createAgentRoomSwarm: vi.fn(),
      listAgentRoomSwarms: vi.fn(),
      getAgentRoomSwarm: vi.fn(() => makeSwarm({ status: 'completed' })),
      updateAgentRoomSwarm: vi.fn(),
      deleteAgentRoomSwarm: vi.fn(),
    };
    mocks.getMessageRepository.mockReturnValue(repo);

    await importModule();
    const handler = registered.get('agent.v2.swarm.deploy')!;
    const { respond } = makeRespond();

    await expect(handler({ id: 'swarm-1' }, makeClient(), respond)).rejects.toThrow(
      'Cannot deploy swarm',
    );
  });
});
