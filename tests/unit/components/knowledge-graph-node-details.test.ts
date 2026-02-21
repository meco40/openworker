import { describe, expect, it } from 'vitest';
import { buildNodeRelationDetails } from '@/components/knowledge/graph/nodeDetails';
import type { KnowledgeGraphApiPayload } from '@/components/knowledge/graph';

const payload: KnowledgeGraphApiPayload = {
  graph: {
    nodes: [
      { id: 'n1', label: 'Lea', category: 'person', owner: 'persona', aliasCount: 0 },
      { id: 'n2', label: 'Sabine', category: 'person', owner: 'shared', aliasCount: 0 },
      { id: 'n3', label: 'Hamburg', category: 'place', owner: 'shared', aliasCount: 0 },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', relationType: 'tochter von', confidence: 0.8 },
      { id: 'e2', source: 'n2', target: 'n1', relationType: 'mutter von', confidence: 0.8 },
      { id: 'e3', source: 'n1', target: 'n3', relationType: 'lebt in', confidence: 0.7 },
    ],
  },
  stats: {
    nodes: 3,
    edges: 3,
    categories: { person: 2, place: 1 },
    truncated: false,
  },
};

describe('buildNodeRelationDetails', () => {
  it('returns selected node and readable relation lines with direction', () => {
    const details = buildNodeRelationDetails(payload, 'n1');
    expect(details?.node.id).toBe('n1');
    expect(details?.relations).toHaveLength(3);

    const readable = details?.relations.map(
      (relation) => `${relation.sourceLabel} --${relation.relationType}--> ${relation.targetLabel}`,
    );
    expect(readable).toContain('Lea --tochter von--> Sabine');
    expect(readable).toContain('Sabine --mutter von--> Lea');
    expect(readable).toContain('Lea --lebt in--> Hamburg');

    const outgoing = details?.relations.filter((relation) => relation.direction === 'outgoing');
    const incoming = details?.relations.filter((relation) => relation.direction === 'incoming');
    expect(outgoing?.length).toBe(2);
    expect(incoming?.length).toBe(1);
  });

  it('returns null when node is not part of payload', () => {
    const details = buildNodeRelationDetails(payload, 'missing');
    expect(details).toBeNull();
  });
});
