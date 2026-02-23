import { describe, expect, it } from 'vitest';
import { shouldSendOnInputKeyDown } from '@/modules/chat/components/ChatInputArea';

describe('shouldSendOnInputKeyDown', () => {
  it('returns true for Enter without modifiers', () => {
    expect(
      shouldSendOnInputKeyDown({
        key: 'Enter',
        altKey: false,
      }),
    ).toBe(true);
  });

  it('returns false for Alt+Enter so a newline can be inserted', () => {
    expect(
      shouldSendOnInputKeyDown({
        key: 'Enter',
        altKey: true,
      }),
    ).toBe(false);
  });
});
