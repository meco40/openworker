import { describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '@/server/rooms/orchestrator';
import { SqliteRoomRepository } from '@/server/rooms/sqliteRoomRepository';

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

describe('RoomOrchestrator reentrancy', () => {
  it('skips overlapping runOnce calls on the same orchestrator instance', async () => {
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
    });

    const [first, second] = await Promise.all([orchestrator.runOnce(), orchestrator.runOnce()]);
    const messages = repo.listMessages(room.id, 20);

    expect(messages).toHaveLength(1);
    expect(first.processedRooms + second.processedRooms).toBe(1);
  });
});
