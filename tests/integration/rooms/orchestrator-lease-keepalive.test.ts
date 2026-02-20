import { describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '@/server/rooms/orchestrator';
import { SqliteRoomRepository } from '@/server/rooms/sqliteRoomRepository';

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              text: 'AI response from room orchestrator',
              model: 'grok-4',
              provider: 'xai',
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            });
          }, 150);
        }),
    ),
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

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

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: vi.fn().mockResolvedValue({
    listSkills: () => [],
  }),
}));

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: vi.fn().mockReturnValue([]),
}));

describe('RoomOrchestrator lease keepalive', () => {
  it('keeps lease ownership during long dispatch', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
      leaseTtlMs: 50,
    });

    const runPromise = orchestrator.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 90));

    const takeover = repo.acquireRoomLease(
      room.id,
      'scheduler-b',
      new Date(Date.now() + 60_000).toISOString(),
    );

    await runPromise;
    expect(takeover.leaseOwner).toBe('scheduler-a');
  });
});
