import { describe, expect, it } from 'vitest';
import { buildSimpleTurnPrompt } from '@/server/agent-room/prompt';

describe('research phase turn prompt', () => {
  it('encourages web_search usage during research phase', () => {
    const prompt = buildSimpleTurnPrompt({
      swarmTitle: 'Test Swarm',
      task: 'Find reliable sources for agent orchestration patterns',
      phase: 'research',
      speaker: {
        personaId: 'persona-1',
        role: 'researcher',
        name: 'Research Agent',
        emoji: '🔎',
      },
      leadPersonaId: 'persona-1',
      recentHistory: '',
      units: [{ personaId: 'persona-1', role: 'researcher', name: 'Research Agent', emoji: '🔎' }],
    });

    expect(prompt).toContain('"web_search"');
    expect(prompt).toContain('source URLs');
  });
});
