import { describe, expect, it, vi } from 'vitest';

describe('unpairChannel unsupported input', () => {
  it('throws unsupported channel before touching credential store', async () => {
    vi.resetModules();

    const getCredentialStoreMock = vi.fn(() => {
      throw new Error('credential store should not be touched');
    });

    vi.doMock('../../../src/server/channels/credentials', () => ({
      getCredentialStore: getCredentialStoreMock,
    }));

    const { unpairChannel } = await import('@/server/channels/pairing/unpair');

    await expect(unpairChannel('signal' as unknown as 'telegram')).rejects.toThrow(
      'Unsupported channel',
    );
    expect(getCredentialStoreMock).not.toHaveBeenCalled();
  });
});
