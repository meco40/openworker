import { describe, expect, it } from 'vitest';
import type { AgentV2EventEnvelope, AgentV2EventType } from '@/server/agent-v2/types';
import {
  clampArtifactForPersistence,
  consumeReplayForCommand,
  trimArtifactHistoryForPayload,
} from '@/modules/agent-room/hooks/useAgentRoomRuntime';

function makeEvent(input: {
  seq: number;
  commandId: string | null;
  type: AgentV2EventType;
  payload?: Record<string, unknown>;
}): AgentV2EventEnvelope {
  return {
    schemaVersion: '2.1',
    eventId: `event-${input.seq}`,
    sessionId: 'session-1',
    commandId: input.commandId,
    seq: input.seq,
    emittedAt: new Date().toISOString(),
    type: input.type,
    payload: input.payload || {},
  };
}

describe('useAgentRoomRuntime replay helpers', () => {
  it('collects model deltas for one command and marks completion only for that command', () => {
    const progress = consumeReplayForCommand({
      events: [
        makeEvent({
          seq: 1,
          commandId: 'cmd-other',
          type: 'agent.v2.model.delta',
          payload: { delta: 'ignore me' },
        }),
        makeEvent({
          seq: 2,
          commandId: 'cmd-1',
          type: 'agent.v2.model.delta',
          payload: { delta: 'Hello ' },
        }),
        makeEvent({
          seq: 3,
          commandId: 'cmd-1',
          type: 'agent.v2.model.delta',
          payload: { delta: 'World' },
        }),
        makeEvent({
          seq: 4,
          commandId: 'cmd-other',
          type: 'agent.v2.command.completed',
          payload: { status: 'completed' },
        }),
        makeEvent({
          seq: 5,
          commandId: 'cmd-1',
          type: 'agent.v2.command.completed',
          payload: { status: 'completed' },
        }),
      ],
      commandId: 'cmd-1',
      fromSeq: 0,
      text: '',
    });

    expect(progress.text).toBe('Hello World');
    expect(progress.completed).toBe(true);
    expect(progress.failed).toBe(false);
    expect(progress.nextSeq).toBe(5);
  });

  it('marks failure when command emits agent.v2.error', () => {
    const progress = consumeReplayForCommand({
      events: [
        makeEvent({
          seq: 2,
          commandId: 'cmd-7',
          type: 'agent.v2.error',
          payload: { message: 'tool execution failed' },
        }),
      ],
      commandId: 'cmd-7',
      fromSeq: 1,
      text: '',
    });

    expect(progress.failed).toBe(true);
    expect(progress.completed).toBe(false);
    expect(progress.errorMessage).toContain('tool execution failed');
    expect(progress.nextSeq).toBe(2);
  });

  it('uses command-completed result message when no deltas were streamed', () => {
    const progress = consumeReplayForCommand({
      events: [
        makeEvent({
          seq: 9,
          commandId: 'cmd-99',
          type: 'agent.v2.command.completed',
          payload: {
            status: 'completed',
            result: { message: 'Final answer text' },
          },
        }),
      ],
      commandId: 'cmd-99',
      fromSeq: 0,
      text: '',
    });

    expect(progress.completed).toBe(true);
    expect(progress.failed).toBe(false);
    expect(progress.text).toBe('Final answer text');
  });

  it('trims persisted artifact and history payload for backend limits', () => {
    const long = 'x'.repeat(10_000);
    const clamped = clampArtifactForPersistence(long, 1_000);
    expect(clamped.length).toBe(1_000);

    const history = ['a'.repeat(5_000), 'b'.repeat(5_000), 'c'.repeat(5_000)];
    const trimmed = trimArtifactHistoryForPayload(history, 11_000);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(11_000);
    expect(trimmed.length).toBeLessThan(history.length);
  });
});
