import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAutoSessionMemoryTrace } from '@/server/diagnostics/autoSessionMemoryTrace';
import { logChatDisplayTrace } from '@/server/diagnostics/chatDisplayTrace';
import { logChatRecallTrace } from '@/server/diagnostics/chatRecallTrace';
import { safeTracePayload } from '@/server/diagnostics/safeTracePayload';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('safe diagnostic traces', () => {
  it('redacts identifiers and query/error text recursively', () => {
    const result = safeTracePayload({
      conversationId: 'conversation-secret',
      nested: { userId: 'user-secret', queryPreview: 'private query' },
      values: [{ nodeId: 'node-secret', error: 'private error' }],
      count: 3,
    });

    expect(result.conversationId).toMatch(/^sha256:/);
    expect((result.nested as Record<string, unknown>).userId).toMatch(/^sha256:/);
    expect((result.nested as Record<string, unknown>).queryPreview).toMatch(/^sha256:/);
    expect((result.values as Array<Record<string, unknown>>)[0].nodeId).toMatch(/^sha256:/);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.count).toBe(3);
  });

  it('requires explicit force-log opt-in for slow/error traces', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CHAT_RECALL_LOGS;
    delete process.env.CHAT_RECALL_FORCE_LOGS;
    delete process.env.AUTO_SESSION_MEMORY_LOGS;
    delete process.env.AUTO_SESSION_MEMORY_FORCE_LOGS;
    delete process.env.CHAT_DISPLAY_LOGS;
    delete process.env.CHAT_DISPLAY_FORCE_LOGS;
    delete process.env.INBOX_V2_LOGS;
    delete process.env.INBOX_V2_FORCE_LOGS;

    logChatRecallTrace('slow', { queryPreview: 'private query' }, { force: true, level: 'warn' });
    logAutoSessionMemoryTrace(
      'failed',
      { error: 'private error' },
      { force: true, level: 'error' },
    );
    logChatDisplayTrace('slow', { conversationId: 'conversation-secret' }, { force: true });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    process.env.CHAT_RECALL_FORCE_LOGS = 'true';
    logChatRecallTrace('slow', { queryPreview: 'private query' }, { force: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).not.toContain('private query');
  });
});
