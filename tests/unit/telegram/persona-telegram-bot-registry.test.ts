import { describe, it, expect, beforeEach } from 'vitest';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

describe('PersonaTelegramBotRegistry', () => {
  let registry: PersonaTelegramBotRegistry;

  beforeEach(() => {
    registry = new PersonaTelegramBotRegistry(':memory:');
  });

  it('returns null for unknown botId', () => {
    expect(registry.getBot('unknown')).toBeNull();
  });

  it('returns null for unknown personaId', () => {
    expect(registry.getBotByPersonaId('persona-x')).toBeNull();
  });

  it('upserts and retrieves a bot', () => {
    registry.upsertBot({
      botId: 'girl',
      personaId: 'persona-1',
      token: 'tok-abc',
      webhookSecret: 'sec-abc',
      peerName: 'girl_bot',
      transport: 'polling',
    });
    const bot = registry.getBot('girl');
    expect(bot?.personaId).toBe('persona-1');
    expect(bot?.token).toBe('tok-abc');
    expect(bot?.peerName).toBe('girl_bot');
    expect(bot?.active).toBe(true);
    expect(bot?.pollingOffset).toBe(0);
  });

  it('getBotByPersonaId works after upsert', () => {
    registry.upsertBot({
      botId: 'nexus',
      personaId: 'persona-2',
      token: 'tok-nexus',
      webhookSecret: 'sec-nexus',
      transport: 'webhook',
    });
    const bot = registry.getBotByPersonaId('persona-2');
    expect(bot?.botId).toBe('nexus');
    expect(bot?.transport).toBe('webhook');
  });

  it('upserts without optional peerName', () => {
    registry.upsertBot({
      botId: 'anon',
      personaId: 'persona-3',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    expect(registry.getBot('anon')?.peerName).toBeNull();
  });

  it('updates existing bot on re-upsert', () => {
    registry.upsertBot({
      botId: 'x',
      personaId: 'px',
      token: 'old',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'x',
      personaId: 'px',
      token: 'new',
      webhookSecret: 's',
      transport: 'webhook',
    });
    const bot = registry.getBot('x');
    expect(bot?.token).toBe('new');
    expect(bot?.transport).toBe('webhook');
  });

  it('removes a bot by botId', () => {
    registry.upsertBot({
      botId: 'temp',
      personaId: 'persona-del',
      token: 'tok',
      webhookSecret: 'sec',
      transport: 'polling',
    });
    registry.removeBot('temp');
    expect(registry.getBot('temp')).toBeNull();
  });

  it('removes a bot by personaId', () => {
    registry.upsertBot({
      botId: 'mybot',
      personaId: 'p-rm',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.removeByPersonaId('p-rm');
    expect(registry.getBotByPersonaId('p-rm')).toBeNull();
  });

  it('lists only active bots', () => {
    registry.upsertBot({
      botId: 'a',
      personaId: 'p1',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'b',
      personaId: 'p2',
      token: 't',
      webhookSecret: 's',
      transport: 'webhook',
    });
    registry.setActive('b', false);
    const active = registry.listActiveBots();
    expect(active).toHaveLength(1);
    expect(active[0].botId).toBe('a');
  });

  it('listAllBots returns active and inactive', () => {
    registry.upsertBot({
      botId: 'c',
      personaId: 'p3',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'd',
      personaId: 'p4',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.setActive('d', false);
    expect(registry.listAllBots()).toHaveLength(2);
  });

  it('updates polling offset', () => {
    registry.upsertBot({
      botId: 'offset-test',
      personaId: 'po',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.setPollingOffset('offset-test', 99);
    expect(registry.getBot('offset-test')?.pollingOffset).toBe(99);
  });

  it('enforces unique personaId constraint', () => {
    registry.upsertBot({
      botId: 'bot1',
      personaId: 'shared-persona',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    // Upserting again with same personaId but different botId should throw (UNIQUE constraint)
    expect(() => {
      registry.upsertBot({
        botId: 'bot2',
        personaId: 'shared-persona',
        token: 't',
        webhookSecret: 's',
        transport: 'polling',
      });
    }).toThrow();
  });
});
