import { describe, expect, it } from 'vitest';
import {
  parseTelegramTarget,
  resolveTelegramTargetChatType,
  stripTelegramInternalPrefixes,
} from '../../../src/server/channels/telegram/targets';

describe('telegram targets', () => {
  it('strips telegram prefixes', () => {
    expect(stripTelegramInternalPrefixes('telegram:123')).toBe('123');
    expect(stripTelegramInternalPrefixes('tg:group:-100123')).toBe('-100123');
  });

  it('parses explicit topic targets', () => {
    expect(parseTelegramTarget('telegram:group:-1001234567890:topic:456')).toEqual({
      chatId: '-1001234567890',
      messageThreadId: 456,
      chatType: 'group',
    });
  });

  it('parses compact topic targets', () => {
    expect(parseTelegramTarget('12345:99')).toEqual({
      chatId: '12345',
      messageThreadId: 99,
      chatType: 'direct',
    });
  });

  it('returns unknown for non-numeric usernames', () => {
    expect(resolveTelegramTargetChatType('telegram:@mybot')).toBe('unknown');
  });
});
