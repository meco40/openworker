import { describe, expect, it } from 'vitest';
import { isMethodAllowed } from '@/server/gateway/method-scopes';

describe('gateway method scopes', () => {
  it('allows safe gateway.call methods', () => {
    expect(isMethodAllowed('gateway.call', 'health')).toBe(true);
    expect(isMethodAllowed('gateway.call', 'channels.list')).toBe(true);
    expect(isMethodAllowed('gateway.call', 'inbox.list')).toBe(true);
    expect(isMethodAllowed('gateway.call', 'sessions.reset')).toBe(true);
  });

  it('blocks out-of-scope methods', () => {
    expect(isMethodAllowed('gateway.call', 'chat.stream')).toBe(false);
    expect(isMethodAllowed('sessions', 'chat.stream')).toBe(false);
  });

  it('allows dedicated chat scope for streaming', () => {
    expect(isMethodAllowed('gateway.chat', 'chat.stream')).toBe(true);
    expect(isMethodAllowed('gateway.chat', 'chat.approval.respond')).toBe(true);
    expect(isMethodAllowed('gateway.chat', 'sessions.reset')).toBe(true);
    expect(isMethodAllowed('gateway.chat', 'inbox.list')).toBe(false);
  });

  it('allows inbox.list for channels scope only', () => {
    expect(isMethodAllowed('channels', 'inbox.list')).toBe(true);
    expect(isMethodAllowed('sessions', 'inbox.list')).toBe(false);
  });
});
