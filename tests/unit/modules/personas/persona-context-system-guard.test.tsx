import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PersonaProvider, usePersona } from '@/modules/personas/PersonaContext';

function Probe() {
  const { activePersonaId, personas, setActivePersonaId, setDataEnabled } = usePersona();

  useEffect(() => {
    setDataEnabled(true);
  }, [setDataEnabled]);

  return (
    <div>
      <div data-testid="active-persona">{activePersonaId ?? 'none'}</div>
      <div data-testid="persona-count">{personas.length}</div>
      <button type="button" onClick={() => setActivePersonaId('master-1')}>
        Select Master
      </button>
      <button type="button" onClick={() => setActivePersonaId('persona-1')}>
        Select Architect
      </button>
    </div>
  );
}

describe('PersonaContext system persona guard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/personas')) {
          return new Response(
            JSON.stringify({
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
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/api/personas/persona-1')) {
          return new Response(
            JSON.stringify({
              persona: {
                id: 'persona-1',
                name: 'Architect',
                slug: 'architect',
                emoji: '🧠',
                systemPersonaKey: null,
                files: {
                  'SOUL.md': '',
                  'AGENTS.md': '',
                  'USER.md': '',
                  'TOOLS.md': '',
                  'HEARTBEAT.md': '',
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: false }), { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears stored Master selections and refuses to activate Master directly', async () => {
    localStorage.setItem('openclaw-active-persona', 'master-1');

    render(
      <PersonaProvider>
        <Probe />
      </PersonaProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('persona-count').textContent).toBe('2');
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-persona').textContent).toBe('none');
    });
    expect(localStorage.getItem('openclaw-active-persona')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /select master/i }));
    await waitFor(() => {
      expect(screen.getByTestId('active-persona').textContent).toBe('none');
    });

    fireEvent.click(screen.getByRole('button', { name: /select architect/i }));
    await waitFor(() => {
      expect(screen.getByTestId('active-persona').textContent).toBe('persona-1');
    });
  });
});
