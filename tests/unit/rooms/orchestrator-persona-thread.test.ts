import { describe, expect, it, vi } from 'vitest';

import { RoomOrchestrator } from '@/server/rooms/orchestrator';
import { SqliteRoomRepository } from '@/server/rooms/sqliteRoomRepository';

type DispatchRequest = {
  modelOverride?: string;
};

const dispatchWithFallbackMock = vi.fn(
  async (_profileId: string, _key: string, request: DispatchRequest) => {
    const turn = dispatchWithFallbackMock.mock.calls.length;
    return {
      ok: true,
      text: `resp-${turn}`,
      model: request.modelOverride || 'grok-4',
      provider: 'xai',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
  },
);

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../../src/server/personas/personaRepository', () => ({
  getPersonaRepository: () => ({
    getPersonaSystemInstruction: vi.fn().mockReturnValue('You are a helpful assistant.'),
    getPersona: vi.fn().mockImplementation((personaId: string) => ({
      id: personaId,
      userId: 'user-a',
      name: personaId === 'persona-1' ? 'Jürgen' : 'Micha',
      emoji: '🤖',
      vibe: 'helpful',
    })),
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

describe('RoomOrchestrator persona thread continuity', () => {
  it('keeps persona history beyond the global 20-message room window', async () => {
    dispatchWithFallbackMock.mockClear();

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

    for (let i = 0; i < 25; i += 1) {
      await orchestrator.runOnce();
    }

    const lastCall = dispatchWithFallbackMock.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();

    const request = lastCall?.[2] as { messages: Array<{ role: string; content: string }> };
    const allContents = request.messages.map((m) => m.content);

    expect(allContents.some((c) => c.trim() === 'resp-1')).toBe(true);
  });

  it('keeps per-persona thread state isolated while syncing cross-persona room messages', async () => {
    dispatchWithFallbackMock.mockClear();

    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      description: 'Diskutiert die Aufgabe.',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.addMember(room.id, 'persona-2', 'Critic', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });

    await orchestrator.runOnce(); // persona-1 => resp-1
    await orchestrator.runOnce(); // persona-2 => resp-2
    await orchestrator.runOnce(); // persona-1 => resp-3

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(3);

    const secondRequest = dispatchWithFallbackMock.mock.calls[1]?.[2] as {
      messages: Array<{ role: string; content: string }>;
    };
    const secondTexts = secondRequest.messages.map((m) => `${m.role}:${m.content}`);
    expect(secondTexts.some((t) => t.includes('user:[Jürgen]: resp-1'))).toBe(true);
    expect(secondTexts.some((t) => t.includes('assistant:resp-1'))).toBe(false);

    const thirdRequest = dispatchWithFallbackMock.mock.calls[2]?.[2] as {
      messages: Array<{ role: string; content: string }>;
    };
    const thirdTexts = thirdRequest.messages.map((m) => `${m.role}:${m.content}`);
    expect(thirdTexts.some((t) => t.includes('assistant:resp-1'))).toBe(true);
    expect(thirdTexts.some((t) => t.includes('user:[Micha]: resp-2'))).toBe(true);
  });
});
