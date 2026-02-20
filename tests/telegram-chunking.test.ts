import { describe, it, expect } from 'vitest';
import { splitTelegramMessage } from '@/server/channels/outbound/telegram';

describe('splitTelegramMessage', () => {
  it('returns the original text when under 4096 chars', () => {
    const text = 'Hello World';
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it('returns the original text when exactly 4096 chars', () => {
    const text = 'a'.repeat(4096);
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it('splits long text at newline boundaries', () => {
    const line = 'a'.repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('splits long text at space boundaries when no newlines', () => {
    const word = 'abcdefgh ';
    const text = word.repeat(600).trim(); // ~5400 chars
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(8192);
    const chunks = splitTelegramMessage(text);
    expect(chunks).toEqual(['a'.repeat(4096), 'a'.repeat(4096)]);
  });

  it('handles a custom maxLen', () => {
    const text = 'Hello World, this is a test message!';
    const chunks = splitTelegramMessage(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });

  it('handles empty text', () => {
    expect(splitTelegramMessage('')).toEqual(['']);
  });
});
