import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaProvider, usePersona } from '@/modules/personas/PersonaContext';

let fetchMock: ReturnType<typeof vi.fn>;

function Probe({ enableDetails }: { enableDetails: boolean }) {
  const {
    activePersona,
    activePersonaId,
    personas,
    setActivePersonaId,
    setActivePersonaDetailsEnabled,
    setDataEnabled,
  } = usePersona();

  useEffect(() => {
    setDataEnabled(true);
    setActivePersonaDetailsEnabled(enableDetails);
  }, [enableDetails, setActivePersonaDetailsEnabled, setDataEnabled]);

  return (
    <div>
      <div data-testid="active-persona">{activePersonaId ?? 'none'}</div>
      <div data-testid="active-persona-name">{activePersona?.name ?? 'none'}</div>
      <div data-testid="persona-count">{personas.length}</div>
      <button type="button" onClick={() => setActivePersonaId('persona-1')}>
        Select Architect
      </button>
    </div>
  );
}

describe('PersonaContext active detail loading', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/personas')) {
        return new Response(
          JSON.stringify({
            personas: [
              {
                id: 'persona-1',
                name: 'Architect',
                slug: 'architect',
                emoji: 'A',
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
              emoji: 'A',
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
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps full active persona details out of list-only views', async () => {
    render(
      <PersonaProvider>
        <Probe enableDetails={false} />
      </PersonaProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('persona-count').textContent).toBe('1');
    });

    fireEvent.click(screen.getByRole('button', { name: /select architect/i }));

    await waitFor(() => {
      expect(screen.getByTestId('active-persona').textContent).toBe('persona-1');
    });
    expect(screen.getByTestId('active-persona-name').textContent).toBe('none');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/personas/persona-1', { cache: 'no-store' });
  });

  it('loads full active persona details for agent-runtime views', async () => {
    render(
      <PersonaProvider>
        <Probe enableDetails={true} />
      </PersonaProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('persona-count').textContent).toBe('1');
    });

    fireEvent.click(screen.getByRole('button', { name: /select architect/i }));

    await waitFor(() => {
      expect(screen.getByTestId('active-persona-name').textContent).toBe('Architect');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/personas/persona-1', { cache: 'no-store' });
  });
});
