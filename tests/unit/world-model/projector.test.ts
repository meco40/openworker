import { describe, expect, it } from 'vitest';

import {
  deriveArtifactKey,
  stableDedupKey,
  textFingerprint,
} from '@/server/world-model/projector/idempotency';
import { normalizeExtraction } from '@/server/world-model/projector/normalizeExtraction';
import type { EntityCategory } from '@/server/knowledge/entityGraph';

const baseResult = {
  facts: ['Mike ist ein Freund', 'Der Kino-Besuch ist am Freitag'],
  teaser: '',
  episode: 'ep',
  meetingLedger: {
    topicKey: 't',
    counterpart: null,
    participants: [],
    decisions: [],
    negotiatedTerms: [],
    openPoints: [],
    actionItems: [],
    sourceRefs: [],
    confidence: 0.6,
  },
  events: [
    {
      eventType: 'activity',
      speakerRole: 'user' as const,
      subject: 'Kino',
      counterpart: '',
      relationLabel: null,
      timeExpression: 'Freitag',
      startDate: '2026-08-21T18:00:00.000Z',
      endDate: '',
      dayCount: 1,
      isConfirmation: false,
      confirmationSignals: [] as string[],
      sourceSeq: [3],
    },
  ],
  entities: [
    {
      name: 'Mike',
      category: 'person' as EntityCategory,
      owner: 'shared' as const,
      aliases: [],
      relations: [{ targetName: 'Kino', relationType: 'attends', direction: 'outgoing' as const }],
      properties: {},
      sourceSeq: [3],
    },
  ],
};

describe('world-model projector', () => {
  it('derives deterministic artifact keys from scope+seq+content', () => {
    const scope = { userId: 'u', personaId: 'p', workspaceId: 'w' };
    const a = deriveArtifactKey({ scope, sourceMessageSeq: 3, kind: 'event', content: 'Kino' });
    const b = deriveArtifactKey({ scope, sourceMessageSeq: 3, kind: 'event', content: 'Kino' });
    expect(a).toBe(b);
    const c = deriveArtifactKey({ scope, sourceMessageSeq: 4, kind: 'event', content: 'Kino' });
    expect(a).not.toBe(c);
  });

  it('produces stable dedup keys', () => {
    const scope = { userId: 'u', personaId: 'p' };
    const k1 = stableDedupKey(
      { scope, sourceMessageSeq: 1, kind: 'loop', content: 'x' },
      'outcome',
    );
    const k2 = stableDedupKey(
      { scope, sourceMessageSeq: 1, kind: 'loop', content: 'x' },
      'outcome',
    );
    expect(k1).toBe(k2);
  });

  it('fingerprints text case-insensitively', () => {
    expect(textFingerprint('Hallo Welt')).toBe(textFingerprint('hallo welt'));
  });

  it('normalizes an extraction result into a projection', () => {
    const projection = normalizeExtraction({
      result: baseResult,
      userId: 'u',
      personaId: 'p',
      workspaceId: 'w',
    });
    expect(projection.assertions.length).toBe(2);
    expect(projection.events.length).toBe(1);
    expect(projection.events[0]?.title).toBe('Kino');
    expect(projection.entities.length).toBe(1);
    expect(projection.relations.length).toBe(1);
    expect(projection.relations[0]?.relationType).toBe('attends');
    expect(projection.confidenceSummary.total).toBeGreaterThan(0);
  });

  it('does not promote unrelated facts to observed from an event confirmation', () => {
    const withConf = {
      ...baseResult,
      events: [
        {
          ...baseResult.events[0]!,
          isConfirmation: true,
        },
      ],
      meetingLedger: { ...baseResult.meetingLedger, confidence: 0.9 },
    };
    const projection = normalizeExtraction({
      result: withConf,
      userId: 'u',
      personaId: 'p',
      workspaceId: 'w',
    });
    expect(projection.assertions.every((a) => a.modality === 'reported')).toBe(true);
  });
});
