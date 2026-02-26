import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import NewSwarmModal from '@/modules/agent-room/components/NewSwarmModal';

describe('NewSwarmModal', () => {
  it('renders persona options from persona registry', () => {
    const html = renderToStaticMarkup(
      createElement(NewSwarmModal, {
        open: true,
        creating: false,
        personas: [
          {
            id: 'persona-1',
            name: 'Architect',
            slug: 'architect',
            emoji: '🧠',
            vibe: 'strict',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'builder',
            isAutonomous: false,
            maxToolCalls: 120,
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'persona-2',
            name: 'Critic',
            slug: 'critic',
            emoji: '🛡️',
            vibe: 'critical',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'assistant',
            isAutonomous: false,
            maxToolCalls: 120,
            updatedAt: new Date().toISOString(),
          },
        ],
        onClose: vi.fn(),
        onCreate: vi.fn(async () => {}),
      }),
    );

    expect(html).toContain('Lead Persona');
    expect(html).toContain('Architect');
    expect(html).toContain('Critic');
    expect(html).toContain('Deploy Agents');
  });
});
