import { describe, expect, it } from 'vitest';
import { chooseNextSpeakerPersonaId } from '@/server/agent-room/prompt';

describe('speaker selector — B1 weighted phase selection', () => {
  const units = [
    { personaId: 'lead', role: 'lead' },
    { personaId: 'analyst-1', role: 'analyst' },
    { personaId: 'creative-1', role: 'creative' },
    { personaId: 'critic-1', role: 'critic' },
  ];

  it('gives analyst more turns during analysis phase', () => {
    // Collect 20 turns and count how often analyst speaks
    const speakers: string[] = [];
    for (let i = 0; i < 20; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units,
          currentPhase: 'analysis',
        }),
      );
    }
    const analystCount = speakers.filter((s) => s === 'analyst-1').length;
    const creativeCount = speakers.filter((s) => s === 'creative-1').length;
    // Analyst (weight 3 in analysis) should appear more than creative (weight 1)
    expect(analystCount).toBeGreaterThan(creativeCount);
  });

  it('gives creative more turns during ideation phase', () => {
    const speakers: string[] = [];
    for (let i = 0; i < 20; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units,
          currentPhase: 'ideation',
        }),
      );
    }
    const creativeCount = speakers.filter((s) => s === 'creative-1').length;
    const analystCount = speakers.filter((s) => s === 'analyst-1').length;
    expect(creativeCount).toBeGreaterThan(analystCount);
  });

  it('gives critic more turns during critique phase', () => {
    const speakers: string[] = [];
    for (let i = 0; i < 20; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units,
          currentPhase: 'critique',
        }),
      );
    }
    const criticCount = speakers.filter((s) => s === 'critic-1').length;
    const analystCount = speakers.filter((s) => s === 'analyst-1').length;
    expect(criticCount).toBeGreaterThan(analystCount);
  });

  it('uses simple round-robin when no currentPhase provided', () => {
    // Without phase weighting, all agents cycle equally
    const speakers: string[] = [];
    for (let i = 0; i < 8; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units,
        }),
      );
    }
    // Each should appear exactly twice in 8 turns
    const counts = new Map<string, number>();
    for (const s of speakers) counts.set(s, (counts.get(s) ?? 0) + 1);
    expect(counts.get('lead')).toBe(2);
    expect(counts.get('analyst-1')).toBe(2);
    expect(counts.get('creative-1')).toBe(2);
    expect(counts.get('critic-1')).toBe(2);
  });

  it('falls back to simple round-robin for unknown phase', () => {
    const speakers: string[] = [];
    for (let i = 0; i < 8; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units,
          currentPhase: 'unknown_phase',
        }),
      );
    }
    const counts = new Map<string, number>();
    for (const s of speakers) counts.set(s, (counts.get(s) ?? 0) + 1);
    expect(counts.get('lead')).toBe(2);
    expect(counts.get('analyst-1')).toBe(2);
  });

  it('lead persona gets boosted weight in result phase', () => {
    const speakers: string[] = [];
    // lead has weight 3 in result phase, others have weight 1
    const resultUnits = [
      { personaId: 'lead', role: 'lead' },
      { personaId: 'spec-1', role: 'specialist' },
    ];
    for (let i = 0; i < 8; i++) {
      speakers.push(
        chooseNextSpeakerPersonaId({
          turnCount: i,
          leadPersonaId: 'lead',
          units: resultUnits,
          currentPhase: 'result',
        }),
      );
    }
    const leadCount = speakers.filter((s) => s === 'lead').length;
    const specCount = speakers.filter((s) => s === 'spec-1').length;
    // lead (weight 3) should appear more than specialist (weight 1)
    expect(leadCount).toBeGreaterThan(specCount);
  });
});
