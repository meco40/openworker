import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';

const state = vi.hoisted(() => ({
  swarm: null as AgentRoomSwarmRecord | null,
  terminal: {} as Record<string, unknown>,
  commands: [] as Array<{ kind: string; content: string; idempotencyKey: string }>,
}));

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  const mocked = { ...crypto, randomUUID: () => 'fixture' };
  return { ...mocked, default: mocked };
});
vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageRepository: () => ({
    listRunningSwarms: () => (state.swarm?.status === 'running' ? [state.swarm] : []),
    getAgentRoomSwarm: () => state.swarm,
    updateAgentRoomSwarm: (_id: string, _user: string, patch: Partial<AgentRoomSwarmRecord>) => {
      if (!state.swarm) throw new Error('Missing test swarm');
      state.swarm = { ...state.swarm, ...patch };
      return state.swarm;
    },
  }),
  getMessageService: () => ({
    setPersonaId: vi.fn(),
    getConversation: () => ({ personaId: 'lead' }),
  }),
}));
vi.mock('@/server/personas/personaRepository', () => ({
  getPersonaRepository: () => ({ getPersona: () => null }),
}));
vi.mock('@/server/gateway/broadcast', () => ({ broadcastToUser: vi.fn() }));
vi.mock('@/server/agent-v2/runtime', () => ({
  getAgentV2SessionManager: () => ({
    startSession: async () => ({ session: { id: 'session-fixture', lastSeq: 0 } }),
    getSession: () => ({ id: 'session-fixture', lastSeq: 0 }),
    enqueueInput: async (input: { content: string; idempotencyKey: string }) => {
      state.commands.push({
        kind: 'input',
        content: input.content,
        idempotencyKey: input.idempotencyKey,
      });
    },
    enqueueFollowUp: async (input: { content: string; idempotencyKey: string }) => {
      state.commands.push({
        kind: 'follow_up',
        content: input.content,
        idempotencyKey: input.idempotencyKey,
      });
    },
    replaySessionEvents: () => (Object.keys(state.terminal).length ? [state.terminal] : []),
    getCommandResult: () => (Object.keys(state.terminal).length ? state.terminal : null),
  }),
}));

import { runOrchestratorOnce } from '@/server/agent-room/orchestrator';

const fields = [
  'sessionId',
  'status',
  'currentPhase',
  'consensusScore',
  'holdFlag',
  'artifact',
  'artifactHistory',
  'friction',
  'lastSeq',
  'currentDeployCommandId',
  'phaseBuffer',
] as const;
const capture = () => {
  if (!state.swarm) throw new Error('Missing swarm');
  const swarm = state.swarm;
  return Object.fromEntries(fields.map((key) => [key, swarm[key]]));
};

afterEach(() => vi.useRealTimers());
describe('Rust and TypeScript swarm orchestration', () => {
  it('matches the trace regenerated and asserted by the real Rust tick test', async () => {
    const trace: {
      input: AgentRoomSwarmRecord;
      dispatch: unknown;
      completion: unknown;
      commands: unknown;
      terminal: Record<string, unknown>;
    } = JSON.parse(
      readFileSync(
        resolve('rust/crates/betaclaw-gateway/tests/fixtures/swarm-parity.json'),
        'utf8',
      ),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    state.swarm = structuredClone(trace.input);
    state.commands = [];
    state.terminal = {};
    await runOrchestratorOnce();
    expect(capture()).toEqual(trace.dispatch);
    expect(state.commands).toEqual(trace.commands);
    state.terminal = trace.terminal;
    await runOrchestratorOnce();
    expect(capture()).toEqual(trace.completion);
  });
});
