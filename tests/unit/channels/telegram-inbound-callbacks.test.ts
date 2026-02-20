import { beforeEach, describe, expect, it, vi } from 'vitest';

const answerTelegramCallbackQuery = vi.fn();
const processTelegramModelCallback = vi.fn();

vi.mock('../../../src/server/channels/outbound/telegram', () => ({
  deliverTelegram: vi.fn(),
  answerTelegramCallbackQuery,
}));

vi.mock('../../../src/server/channels/telegram/modelSelection', () => ({
  handleTelegramNativeCommand: vi.fn().mockResolvedValue(false),
  processTelegramModelCallback,
}));

vi.mock('../../../src/server/channels/pairing/telegramCodePairing', () => ({
  ensureTelegramPairingCode: vi.fn(),
  isTelegramChatAuthorized: (chatId: string) => chatId === '123',
}));

describe('telegram inbound callback handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects callback updates from unpaired chats', async () => {
    const { processTelegramInboundUpdate } = await import(
      '../../../src/server/channels/pairing/telegramInbound'
    );

    const result = await processTelegramInboundUpdate({
      callback_query: {
        id: 'cb-1',
        data: 'mdl_prov',
        message: {
          message_id: 10,
          chat: { id: 999 },
        },
      },
    });

    expect(result).toEqual({ handled: true, codeIssued: false });
    expect(answerTelegramCallbackQuery).toHaveBeenCalledWith('cb-1', 'Pairing required.');
    expect(processTelegramModelCallback).not.toHaveBeenCalled();
  });

  it('dispatches authorized callback updates to model handler', async () => {
    processTelegramModelCallback.mockResolvedValue(true);
    const { processTelegramInboundUpdate } = await import(
      '../../../src/server/channels/pairing/telegramInbound'
    );

    const update = {
      callback_query: {
        id: 'cb-2',
        data: 'mdl_sel_openai/gpt-4o',
        message: {
          message_id: 11,
          chat: { id: 123 },
        },
      },
    };

    const result = await processTelegramInboundUpdate(update);

    expect(result).toEqual({ handled: true, codeIssued: false });
    expect(processTelegramModelCallback).toHaveBeenCalledWith(update.callback_query);
  });
});
