import { beforeEach, describe, expect, it, vi } from 'vitest';

const listConversations = vi.fn();
const count = vi.fn();
const getMemoryService = vi.fn(() => ({ count }));
const getMemoryServiceIfReady = vi.fn();

vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageRepository: () => ({
    listConversations,
  }),
}));

vi.mock('@/server/memory/runtime', () => ({
  getMemoryService,
  getMemoryServiceIfReady,
}));

describe('vectorNodeCount', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getMemoryServiceIfReady.mockReset();
    getMemoryService.mockReset().mockReturnValue({ count });
    count.mockReset();
    listConversations.mockReset();
    listConversations.mockReturnValue([]);
    count.mockResolvedValue(0);
  });

  it('returns -1 immediately when the memory runtime is degraded', async () => {
    getMemoryServiceIfReady.mockReturnValue(null);
    const { resolveVectorNodeCountSafe } = await import('@/server/control-plane/vectorNodeCount');

    await expect(resolveVectorNodeCountSafe('legacy-local-user')).resolves.toBe(-1);
    expect(getMemoryService).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('counts the direct user scope for non-legacy users', async () => {
    count.mockResolvedValue(3);
    const { resolveVectorNodeCountSafe } = await import('@/server/control-plane/vectorNodeCount');

    await expect(resolveVectorNodeCountSafe('metrics-user')).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith(undefined, 'metrics-user');
  });

  it('adds channel scopes for the legacy local user and sums the counts', async () => {
    listConversations.mockReturnValue([
      { channelType: 'Telegram', externalChatId: '1527785051' },
      { channelType: 'WebChat', externalChatId: 'skip-me' },
      { channelType: 'Discord', externalChatId: 'guild-99' },
    ]);
    count.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(4);

    const { resolveVectorNodeCountSafe } = await import('@/server/control-plane/vectorNodeCount');

    await expect(resolveVectorNodeCountSafe('legacy-local-user')).resolves.toBe(7);
    expect(count).toHaveBeenNthCalledWith(1, undefined, 'legacy-local-user');
    expect(count).toHaveBeenNthCalledWith(2, undefined, 'channel:telegram:1527785051');
    expect(count).toHaveBeenNthCalledWith(3, undefined, 'channel:discord:guild-99');
  });

  it('discovers legacy channel scopes beyond the first 50 conversations', async () => {
    listConversations.mockReturnValue([
      ...Array.from({ length: 50 }, (_, index) => ({
        channelType: 'Telegram',
        externalChatId: `chat-${index}`,
      })),
      { channelType: 'Discord', externalChatId: 'chat-51' },
    ]);
    count.mockResolvedValue(1);

    const { resolveVectorNodeCountSafe } = await import('@/server/control-plane/vectorNodeCount');

    await expect(resolveVectorNodeCountSafe('legacy-local-user')).resolves.toBe(52);
    expect(listConversations).toHaveBeenCalledWith(500, 'legacy-local-user');
    expect(count).toHaveBeenCalledWith(undefined, 'channel:discord:chat-51');
  });
});
