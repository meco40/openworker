import { afterEach, describe, expect, it, vi } from 'vitest';

const getPersonaWithFiles = vi.fn(() => ({ id: 'persona-1', userId: 'user-1', files: [] }));

vi.mock('@/server/personas/personaRepository', () => ({
  getPersonaRepository: () => ({ getPersonaWithFiles }),
}));

vi.mock('@/server/auth/userContext', () => ({
  resolveRequestUserContext: vi.fn(async () => ({ userId: 'user-1', authenticated: true })),
}));

describe('personas route lazy-loading behavior', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/server/model-hub/runtime');
    vi.doUnmock('@/server/memory/runtime');
    vi.doUnmock('@/server/channels/messages/runtime');
    vi.doUnmock('@/server/knowledge/runtime');
    vi.doUnmock('@/server/telegram/personaTelegramPairing');
  });

  it('keeps GET independent from model-hub, memory, channel and knowledge runtimes', async () => {
    const eagerImport = vi.fn(() => {
      throw new Error('runtime was imported eagerly');
    });
    vi.doMock('@/server/model-hub/runtime', eagerImport);
    vi.doMock('@/server/memory/runtime', eagerImport);
    vi.doMock('@/server/channels/messages/runtime', eagerImport);
    vi.doMock('@/server/knowledge/runtime', eagerImport);
    vi.doMock('@/server/telegram/personaTelegramPairing', eagerImport);

    const { GET } = await import('../../../app/api/personas/[id]/route');
    const response = await GET(new Request('http://localhost/api/personas/persona-1'), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(200);
    expect(getPersonaWithFiles).toHaveBeenCalledWith('persona-1');
    expect(eagerImport).not.toHaveBeenCalled();
  });
});
