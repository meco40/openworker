import { describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '../../../src/server/rooms/orchestrator';
import { SqliteRoomRepository } from '../../../src/server/rooms/sqliteRoomRepository';
import type { AppendRoomMessageInput } from '../../../src/server/rooms/types';

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

vi.mock('../../../skills/definitions', () => ({
  mapSkillsToTools: vi.fn().mockReturnValue([]),
}));

class StopBeforeFinalHeartbeatRepository extends SqliteRoomRepository {
  private stopped = false;

  override appendMessage(input: AppendRoomMessageInput) {
    if (!this.stopped && input.speakerType === 'persona') {
      this.closeActiveRoomRun(input.roomId, 'stopped', null);
      this.stopped = true;
    }
    return super.appendMessage(input);
  }
}

describe('rooms hardening baseline repros', () => {
  it('should keep room state as stopped when stop happens during a cycle', async () => {
    const repo = new StopBeforeFinalHeartbeatRepository(':memory:');
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

    await orchestrator.runOnce();
    const updated = repo.getRoom(room.id);

    expect(updated?.runState).toBe('stopped');
  });
});
