import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliverTelegram = vi.fn();
const editTelegramMessage = vi.fn();
const answerTelegramCallbackQuery = vi.fn();
const setModelOverride = vi.fn();
const getOrCreateConversation = vi.fn();
const listPipeline = vi.fn();

vi.mock('../../../src/server/channels/outbound/telegram', () => ({
  deliverTelegram,
  editTelegramMessage,
  answerTelegramCallbackQuery,
  buildInlineKeyboard: (rows: Array<Array<{ text: string; callback_data: string }>>) => ({
    inline_keyboard: rows,
  }),
}));

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    getOrCreateConversation,
    setModelOverride,
  }),
}));

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    listPipeline,
  }),
}));

describe('telegram model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateConversation.mockReturnValue({
      id: 'conv-1',
      userId: 'legacy-local-user',
      modelOverride: null,
    });
    listPipeline.mockReturnValue([
      {
        id: 'm1',
        profileId: 'p1',
        accountId: 'a1',
        providerId: 'openai',
        modelName: 'gpt-4o',
        priority: 1,
        status: 'active',
        createdAt: '2026-02-19T00:00:00.000Z',
        updatedAt: '2026-02-19T00:00:00.000Z',
      },
      {
        id: 'm2',
        profileId: 'p1',
        accountId: 'a2',
        providerId: 'openai',
        modelName: 'gpt-4.1',
        priority: 2,
        status: 'active',
        createdAt: '2026-02-19T00:00:00.000Z',
        updatedAt: '2026-02-19T00:00:00.000Z',
      },
      {
        id: 'm3',
        profileId: 'p1',
        accountId: 'a3',
        providerId: 'gemini',
        modelName: 'gemini-2.5-pro',
        priority: 3,
        status: 'active',
        createdAt: '2026-02-19T00:00:00.000Z',
        updatedAt: '2026-02-19T00:00:00.000Z',
      },
    ]);
  });

  it('handles /model command and sends provider menu', async () => {
    const { handleTelegramNativeCommand } =
      await import('@/server/channels/telegram/modelSelection');

    const handled = await handleTelegramNativeCommand('123', '/model');

    expect(handled).toBe(true);
    expect(deliverTelegram).toHaveBeenCalledTimes(1);
    expect(setModelOverride).not.toHaveBeenCalled();
    expect(String(deliverTelegram.mock.calls[0][1])).toContain('Model selection');
  });

  it('clears override when /model off is used', async () => {
    getOrCreateConversation.mockReturnValue({
      id: 'conv-1',
      userId: 'legacy-local-user',
      modelOverride: 'gpt-4o',
    });

    const { handleTelegramNativeCommand } =
      await import('@/server/channels/telegram/modelSelection');

    const handled = await handleTelegramNativeCommand('123', '/model off');

    expect(handled).toBe(true);
    expect(setModelOverride).toHaveBeenCalledWith('conv-1', null, 'legacy-local-user');
  });

  it('applies model override from callback selection', async () => {
    const { processTelegramModelCallback } =
      await import('@/server/channels/telegram/modelSelection');

    const handled = await processTelegramModelCallback({
      id: 'cb-1',
      data: 'mdl_sel_openai/gpt-4o',
      message: { message_id: 11, chat: { id: 123 } },
    });

    expect(handled).toBe(true);
    expect(setModelOverride).toHaveBeenCalledWith('conv-1', 'gpt-4o', 'legacy-local-user');
    expect(answerTelegramCallbackQuery).toHaveBeenCalledWith('cb-1', 'Model set: gpt-4o');
    expect(editTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown callback payloads', async () => {
    const { processTelegramModelCallback } =
      await import('@/server/channels/telegram/modelSelection');

    const handled = await processTelegramModelCallback({
      id: 'cb-2',
      data: 'not_model_payload',
      message: { message_id: 12, chat: { id: 123 } },
    });

    expect(handled).toBe(false);
    expect(setModelOverride).not.toHaveBeenCalled();
  });
});
