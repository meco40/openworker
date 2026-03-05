import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ChatMainPane from '@/modules/chat/components/ChatMainPane';

const mockUsePersona = vi.fn();

vi.mock('@/modules/personas/PersonaContext', () => ({
  usePersona: () => mockUsePersona(),
}));

describe('ChatMainPane persona filtering', () => {
  it('excludes the Master system persona from the normal persona dropdown', () => {
    mockUsePersona.mockReturnValue({
      activePersona: null,
      personas: [
        {
          id: 'master-1',
          name: 'Master',
          slug: 'master',
          emoji: '🧭',
          systemPersonaKey: 'master',
        },
        {
          id: 'persona-1',
          name: 'Architect',
          slug: 'architect',
          emoji: '🧠',
          systemPersonaKey: null,
        },
      ],
      activePersonaId: null,
      setActivePersonaId: vi.fn(),
    });

    render(
      <ChatMainPane
        activeConversation={
          {
            id: 'conv-1',
            title: 'Inbox',
            channelType: 'web',
          } as never
        }
        messages={[]}
        chatStreamDebug={{ phase: 'idle', transport: 'final-only' } as never}
        onDeleteMessage={vi.fn()}
        onRespondApproval={vi.fn()}
        scrollRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByTestId('persona-dropdown-toggle'));

    const menu = screen.getByTestId('persona-dropdown-menu');
    expect(within(menu).getByRole('button', { name: /architect/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: /master/i })).not.toBeInTheDocument();
  });
});
