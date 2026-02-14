import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerOrchestraTab from '../../../components/worker/WorkerOrchestraTab';

vi.mock('../../../src/modules/worker/hooks/useWorkerOrchestraFlows', () => ({
  useWorkerOrchestraFlows: () => ({
    drafts: [
      {
        id: 'draft-1',
        name: 'Mock Draft',
        workspaceType: 'research',
        graphJson: JSON.stringify({
          startNodeId: 'n1',
          nodes: [
            { id: 'n1', personaId: 'persona-research', position: { x: 0, y: 0 } },
            { id: 'n2', personaId: 'persona-review', position: { x: 0, y: 100 } },
          ],
          edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
        }),
        updatedAt: new Date().toISOString(),
      },
    ],
    published: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    createDraft: vi.fn(),
    publishDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
  }),
}));

vi.mock('../../../src/modules/personas/PersonaContext', () => ({
  usePersona: () => ({
    personas: [],
    loading: false,
  }),
}));

describe('worker orchestra tab', () => {
  it('renders orchestra tab shell', () => {
    const html = renderToStaticMarkup(createElement(WorkerOrchestraTab));
    expect(html).toContain('Orchestra');
    expect(html).toContain('Draft erstellen');
    expect(html).toContain('Mock Draft');
  });
});
