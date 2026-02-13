import { describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '../../../src/server/rooms/orchestrator';
import { SqliteRoomRepository } from '../../../src/server/rooms/sqliteRoomRepository';

// Mock the model hub runtime — return a simple text response
vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: vi.fn().mockResolvedValue({
      ok: true,
      text: 'AI response from room orchestrator',
      model: 'grok-4',
      provider: 'xai',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

// Mock persona repository
vi.mock('../../../src/server/personas/personaRepository', () => ({
  getPersonaRepository: () => ({
    getPersonaSystemInstruction: vi.fn().mockReturnValue('You are a helpful assistant.'),
    getPersona: vi.fn().mockReturnValue({
      id: 'persona-1',
      userId: 'user-a',
      name: 'Test Persona',
      emoji: '🤖',
      vibe: 'helpful',
    }),
  }),
}));

// Mock skill repository — return empty skills (no tools available)
vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: vi.fn().mockResolvedValue({
    listSkills: () => [],
  }),
}));

// Mock skill definitions
vi.mock('../../../skills/definitions', () => ({
  mapSkillsToTools: vi.fn().mockReturnValue([]),
}));

describe('rooms runtime orchestrator', () => {
  it('processes running rooms and appends an AI-generated room message', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.setPersonaPermissions('persona-1', { tools: { search: true } });

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    const result = await orchestrator.runOnce();

    expect(result.processedRooms).toBe(1);
    expect(result.createdMessages).toBe(1);
    const messages = repo.listMessages(room.id, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.speakerType).toBe('persona');
    expect(messages[0]?.content).toBe('AI response from room orchestrator');
  });

  it('acquires lease for running room and records the active run', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.setPersonaPermissions('persona-1', { tools: { search: false } });

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    await orchestrator.runOnce();

    const activeRun = repo.getActiveRoomRun(room.id);
    expect(activeRun).toBeTruthy();
    expect(activeRun?.leaseOwner).toBe('scheduler-a');
    expect(activeRun?.runState).toBe('running');
  });

  it('skips room when lease is currently held by another scheduler instance', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.acquireRoomLease(room.id, 'scheduler-b', new Date(Date.now() + 120_000).toISOString());

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    const result = await orchestrator.runOnce();

    expect(result.processedRooms).toBe(0);
    expect(repo.listMessages(room.id, 20)).toHaveLength(0);
  });

  it('marks run degraded when no model can be resolved for any member', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p-office',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: {},
    });
    await orchestrator.runOnce();

    const updated = repo.getRoom(room.id);
    expect(updated?.runState).toBe('degraded');
  });

  it('creates room with free goal mode', () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Open Discussion',
      goalMode: 'free',
      routingProfileId: 'p1',
    });
    expect(room.goalMode).toBe('free');
  });

  it('supports extended member runtime statuses', () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, null);

    for (const status of [
      'idle',
      'busy',
      'interrupting',
      'interrupted',
      'error',
      'paused',
    ] as const) {
      const runtime = repo.upsertMemberRuntime({
        roomId: room.id,
        personaId: 'persona-1',
        status,
        busyReason: status === 'idle' ? null : `Reason: ${status}`,
      });
      expect(runtime.status).toBe(status);
    }
  });

  it('skips paused members during orchestration', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.addMember(room.id, 'persona-2', 'Reviewer', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');

    repo.upsertMemberRuntime({
      roomId: room.id,
      personaId: 'persona-1',
      status: 'paused',
      busyReason: 'Paused by user',
    });

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    const result = await orchestrator.runOnce();
    const messages = repo.listMessages(room.id, 10);

    expect(result.processedRooms).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.speakerPersonaId).toBe('persona-2');
  });
});
