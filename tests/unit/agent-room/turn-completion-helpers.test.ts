import { describe, expect, it } from 'vitest';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import {
  findCompletionEvent,
  extractCompletedText,
} from '@/server/agent-room/services/turnCompletion.service';

function makeEvent(overrides: Partial<AgentV2EventEnvelope> = {}): AgentV2EventEnvelope {
  return {
    schemaVersion: '2.1',
    eventId: 'evt-1',
    sessionId: 'sess-1',
    commandId: 'cmd-target',
    seq: 1,
    emittedAt: '2026-01-01T00:00:00Z',
    type: 'agent.v2.command.completed',
    payload: {},
    ...overrides,
  };
}

describe('turnCompletion helpers', () => {
  describe('findCompletionEvent', () => {
    it('returns null for empty events array', () => {
      expect(findCompletionEvent([], 'cmd-1')).toBeNull();
    });

    it('finds agent.v2.command.completed event matching commandId', () => {
      const events = [makeEvent({ commandId: 'cmd-target', type: 'agent.v2.command.completed' })];
      const result = findCompletionEvent(events, 'cmd-target');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('agent.v2.command.completed');
    });

    it('finds agent.v2.error event matching commandId', () => {
      const events = [makeEvent({ commandId: 'cmd-target', type: 'agent.v2.error' })];
      const result = findCompletionEvent(events, 'cmd-target');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('agent.v2.error');
    });

    it('ignores events with non-matching commandId', () => {
      const events = [makeEvent({ commandId: 'other-cmd', type: 'agent.v2.command.completed' })];
      expect(findCompletionEvent(events, 'cmd-target')).toBeNull();
    });

    it('ignores non-terminal event types', () => {
      const events = [
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.model.delta' }),
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.tool.started' }),
      ];
      expect(findCompletionEvent(events, 'cmd-target')).toBeNull();
    });

    it('returns the first terminal event when multiple exist', () => {
      const events = [
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.model.delta', seq: 1 }),
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.command.completed', seq: 2 }),
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.error', seq: 3 }),
      ];
      const result = findCompletionEvent(events, 'cmd-target');
      expect(result!.type).toBe('agent.v2.command.completed');
      expect(result!.seq).toBe(2);
    });

    it('skips non-matching until finding the match', () => {
      const events = [
        makeEvent({ commandId: 'other', type: 'agent.v2.command.completed', seq: 1 }),
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.model.delta', seq: 2 }),
        makeEvent({ commandId: 'cmd-target', type: 'agent.v2.command.completed', seq: 3 }),
      ];
      const result = findCompletionEvent(events, 'cmd-target');
      expect(result).not.toBeNull();
      expect(result!.seq).toBe(3);
    });
  });

  describe('extractCompletedText', () => {
    it('extracts text from payload.result.message', () => {
      const event = makeEvent({
        payload: { result: { message: 'Analysis complete.' } },
      });
      expect(extractCompletedText(event)).toBe('Analysis complete.');
    });

    it('extracts text from payload.result.content', () => {
      const event = makeEvent({
        payload: { result: { content: 'Generated content.' } },
      });
      expect(extractCompletedText(event)).toBe('Generated content.');
    });

    it('prefers result.message over result.content', () => {
      const event = makeEvent({
        payload: { result: { message: 'From message.', content: 'From content.' } },
      });
      expect(extractCompletedText(event)).toBe('From message.');
    });

    it('falls back to payload.text', () => {
      const event = makeEvent({
        payload: { text: 'Fallback text.' },
      });
      expect(extractCompletedText(event)).toBe('Fallback text.');
    });

    it('falls back to payload.content', () => {
      const event = makeEvent({
        payload: { content: 'Content fallback.' },
      });
      expect(extractCompletedText(event)).toBe('Content fallback.');
    });

    it('falls back to payload.message', () => {
      const event = makeEvent({
        payload: { message: 'Message fallback.' },
      });
      expect(extractCompletedText(event)).toBe('Message fallback.');
    });

    it('returns empty string when no recognized fields exist', () => {
      const event = makeEvent({ payload: { foo: 'bar' } });
      expect(extractCompletedText(event)).toBe('');
    });

    it('returns empty string for empty payload', () => {
      const event = makeEvent({ payload: {} });
      expect(extractCompletedText(event)).toBe('');
    });

    it('handles result that is not an object', () => {
      const event = makeEvent({
        payload: { result: 'string-result' },
      });
      // result is not an object, so falls through — no message/content on string
      expect(extractCompletedText(event)).toBe('');
    });
  });
});
