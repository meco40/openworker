import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '../../../src/server/rooms/orchestrator';
import { SqliteRoomRepository } from '../../../src/server/rooms/sqliteRoomRepository';

const dispatchWithFallbackMock = vi.fn().mockResolvedValue({
  ok: true,
  text: 'AI response from room orchestrator',
  model: 'grok-4',
  provider: 'xai',
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
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

vi.mock('../../../src/server/clawhub/clawhubService', () => ({
  getClawHubService: () => ({
    getPromptBlock: vi.fn().mockResolvedValue('CLAWHUB ROOM BLOCK'),
  }),
}));

describe('RoomOrchestrator ClawHub prompt hydration', () => {
  afterEach(() => {
    dispatchWithFallbackMock.mockClear();
  });

  it('appends enabled ClawHub prompt block to room system message', async () => {
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

    expect(dispatchWithFallbackMock).toHaveBeenCalled();
    const payload = dispatchWithFallbackMock.mock.calls[0]?.[2] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(payload?.messages?.[0]?.content).toContain('CLAWHUB ROOM BLOCK');
  });
});
