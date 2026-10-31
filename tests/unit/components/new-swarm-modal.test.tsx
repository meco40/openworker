import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import NewSwarmModal from '@/modules/agent-room/components/NewSwarmModal';
import type { MockProcedure } from '../../helpers/mockProcedure';

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
            systemPersonaKey: null,
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'builder',
            isAutonomous: false,
            maxToolCalls: 120,
            allowedToolFunctionNames: [],
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'persona-2',
            name: 'Critic',
            slug: 'critic',
            emoji: '🛡️',
            vibe: 'critical',
            systemPersonaKey: null,
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'assistant',
            isAutonomous: false,
            maxToolCalls: 120,
            allowedToolFunctionNames: [],
            updatedAt: new Date().toISOString(),
          },
        ],
        onClose: vi.fn<MockProcedure>(),
        onCreate: vi.fn<() => Promise<void>>(async () => {}),
      }),
    );

    expect(html).toContain('Lead Persona');
    expect(html).toContain('Architect');
    expect(html).toContain('Critic');
    expect(html).toContain('Deploy Agents');
  });

  it('does not expose the Master system persona as a swarm participant', () => {
    const html = renderToStaticMarkup(
      createElement(NewSwarmModal, {
        open: true,
        creating: false,
        personas: [
          {
            id: 'master-1',
            name: 'Master',
            slug: 'master',
            emoji: '🧭',
            vibe: 'system',
            systemPersonaKey: 'master',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'assistant',
            isAutonomous: true,
            maxToolCalls: 120,
            allowedToolFunctionNames: [],
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'persona-2',
            name: 'Critic',
            slug: 'critic',
            emoji: '🛡️',
            vibe: 'critical',
            systemPersonaKey: null,
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'assistant',
            isAutonomous: false,
            maxToolCalls: 120,
            allowedToolFunctionNames: [],
            updatedAt: new Date().toISOString(),
          },
        ],
        onClose: vi.fn<MockProcedure>(),
        onCreate: vi.fn<() => Promise<void>>(async () => {}),
      }),
    );

    expect(html).toContain('Critic');
    expect(html).not.toContain('Master');
  });
});
