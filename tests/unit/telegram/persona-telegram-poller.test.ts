import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import {
  isPersonaBotPollingActive,
  startPersonaBotPolling,
  stopAllPersonaBotPolling,
} from '@/server/telegram/personaTelegramPoller';

describe('persona telegram poller', () => {
  beforeEach(() => {
    stopAllPersonaBotPolling();
    (globalThis as Record<string, unknown>).__personaTelegramBotRegistry =
      new PersonaTelegramBotRegistry(':memory:');
  });

  afterEach(() => {
    stopAllPersonaBotPolling();
  });

  it('does not start a second active poller for duplicate bot token', async () => {
    const registry = (globalThis as Record<string, unknown>)
      .__personaTelegramBotRegistry as PersonaTelegramBotRegistry;

    registry.upsertBot({
      botId: 'bot-1',
      personaId: 'persona-1',
      token: 'shared-token',
      webhookSecret: 'secret-1',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'bot-2',
      personaId: 'persona-2',
      token: 'shared-token',
      webhookSecret: 'secret-2',
      transport: 'polling',
    });

    await startPersonaBotPolling('bot-1');
    await startPersonaBotPolling('bot-2');

    expect(isPersonaBotPollingActive('bot-1')).toBe(true);
    expect(isPersonaBotPollingActive('bot-2')).toBe(false);
  });

  it('keeps unique-token pollers active', async () => {
    const registry = (globalThis as Record<string, unknown>)
      .__personaTelegramBotRegistry as PersonaTelegramBotRegistry;

    registry.upsertBot({
      botId: 'bot-a',
      personaId: 'persona-a',
      token: 'token-a',
      webhookSecret: 'secret-a',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'bot-b',
      personaId: 'persona-b',
      token: 'token-b',
      webhookSecret: 'secret-b',
      transport: 'polling',
    });

    await startPersonaBotPolling('bot-a');
    await startPersonaBotPolling('bot-b');

    expect(isPersonaBotPollingActive('bot-a')).toBe(true);
    expect(isPersonaBotPollingActive('bot-b')).toBe(true);
  });
});
