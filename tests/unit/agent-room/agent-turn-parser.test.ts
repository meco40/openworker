import { describe, expect, it } from 'vitest';
import { parseAgentTurns } from '@/modules/agent-room/agentTurnParser';

const units = [
  { personaId: 'p-next', role: 'lead', name: 'Next.js Dev', emoji: '👨‍💻' },
  { personaId: 'p-nata', role: 'specialist', name: 'Nata', emoji: '🤖' },
];
const unitsWithUuidPersonaIds = [
  {
    personaId: '326e3a5b-bdcb-41b2-b851-e425ab1b3223',
    role: 'lead',
    name: 'Next.js Dev',
    emoji: '👨‍💻',
  },
  {
    personaId: 'b1350d29-8b3d-4367-9c90-4e62dd621ded',
    role: 'specialist',
    name: 'Nata',
    emoji: '🤖',
  },
];

describe('agent turn parser', () => {
  it('splits turns for the standard marker format **[Name]:**', () => {
    const turns = parseAgentTurns(
      '**[Next.js Dev]:** First turn\n\n**[Nata]:** Second turn',
      units,
      'p-next',
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.personaId).toBe('p-next');
    expect(turns[0]?.content).toBe('First turn');
    expect(turns[1]?.personaId).toBe('p-nata');
    expect(turns[1]?.content).toBe('Second turn');
  });

  it('ignores inline command-id markers and keeps the declared speaker persona', () => {
    const turns = parseAgentTurns(
      '**[Nata]:** First pass\n\n**[Next.js Dev]:** **[326e3a5b-bdcb-41b2-b851-e425ab1b3223]:** Second pass',
      units,
      'p-next',
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.personaName).toBe('Nata');
    expect(turns[1]?.personaName).toBe('Next.js Dev');
    expect(turns[1]?.content).toBe('Second pass');
  });

  it('uses fallback persona for command-id-only markers', () => {
    const turns = parseAgentTurns('**[command-abcdef123456]:** Specialist answer', units, 'p-next');

    expect(turns).toHaveLength(1);
    expect(turns[0]?.personaId).toBe('p-next');
    expect(turns[0]?.personaName).toBe('Next.js Dev');
    expect(turns[0]?.content).toBe('Specialist answer');
  });

  it('maps persona-id markers to the matching persona', () => {
    const turns = parseAgentTurns(
      '**[326e3a5b-bdcb-41b2-b851-e425ab1b3223]:** Specialist answer',
      unitsWithUuidPersonaIds,
      '326e3a5b-bdcb-41b2-b851-e425ab1b3223',
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.personaName).toBe('Next.js Dev');
    expect(turns[0]?.personaEmoji).toBe('👨‍💻');
    expect(turns[0]?.content).toBe('Specialist answer');
  });
});
