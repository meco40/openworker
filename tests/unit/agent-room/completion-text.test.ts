import { describe, expect, it } from 'vitest';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import { extractCommandCompletionText } from '@/modules/agent-room/completionText';

function eventWithPayload(payload: Record<string, unknown>): AgentV2EventEnvelope {
  return {
    schemaVersion: '2.1',
    eventId: 'evt-1',
    sessionId: 'session-1',
    commandId: 'cmd-1',
    seq: 1,
    emittedAt: new Date().toISOString(),
    type: 'agent.v2.command.completed',
    payload,
  };
}

describe('agent room completion text extraction', () => {
  it('prefers result.message and falls back to payload message/content', () => {
    expect(
      extractCommandCompletionText(
        eventWithPayload({ result: { message: 'from-result' }, message: 'from-message' }),
      ),
    ).toBe('from-result');

    expect(extractCommandCompletionText(eventWithPayload({ message: 'from-message' }))).toBe(
      'from-message',
    );

    expect(extractCommandCompletionText(eventWithPayload({ content: 'from-content' }))).toBe(
      'from-content',
    );
  });
});
