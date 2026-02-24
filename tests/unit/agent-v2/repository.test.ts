import { describe, expect, it } from 'vitest';
import { AgentV2Repository } from '@/server/agent-v2/repository';
import { AgentV2Error } from '@/server/agent-v2/errors';

describe('AgentV2Repository', () => {
  it('enforces idempotency per session and command type', () => {
    const repo = new AgentV2Repository(':memory:');
    const created = repo.createSession({
      userId: 'user-1',
      conversationId: 'conv-1',
    });

    const first = repo.enqueueCommand({
      sessionId: created.session.id,
      userId: 'user-1',
      commandType: 'input',
      priority: 100,
      payload: { content: 'hello' },
      idempotencyKey: 'k-1',
    });
    const second = repo.enqueueCommand({
      sessionId: created.session.id,
      userId: 'user-1',
      commandType: 'input',
      priority: 100,
      payload: { content: 'hello again' },
      idempotencyKey: 'k-1',
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.command.id).toBe(first.command.id);
    repo.close();
  });

  it('starts queued commands by priority order', () => {
    const repo = new AgentV2Repository(':memory:');
    const created = repo.createSession({
      userId: 'user-2',
      conversationId: 'conv-2',
    });

    repo.enqueueCommand({
      sessionId: created.session.id,
      userId: 'user-2',
      commandType: 'follow_up',
      priority: 200,
      payload: { content: 'follow-up' },
    });
    repo.enqueueCommand({
      sessionId: created.session.id,
      userId: 'user-2',
      commandType: 'steer',
      priority: 300,
      payload: { content: 'steer' },
    });

    const started = repo.startNextQueuedCommand(created.session.id, 'user-2');
    expect(started).not.toBeNull();
    expect(started?.command.commandType).toBe('steer');
    repo.close();
  });

  it('returns replay window expired after retention prune', () => {
    const repo = new AgentV2Repository(':memory:');
    const created = repo.createSession({
      userId: 'user-3',
      conversationId: 'conv-3',
    });

    repo.enqueueCommand({
      sessionId: created.session.id,
      userId: 'user-3',
      commandType: 'input',
      priority: 100,
      payload: { content: 'test' },
    });

    repo.pruneExpiredEvents(new Date(Date.now() + 1000 * 60 * 60 * 25));

    expect(() =>
      repo.replayEvents({
        sessionId: created.session.id,
        userId: 'user-3',
        fromSeq: 0,
      }),
    ).toThrowError(AgentV2Error);

    try {
      repo.replayEvents({
        sessionId: created.session.id,
        userId: 'user-3',
        fromSeq: 0,
      });
    } catch (error) {
      expect((error as AgentV2Error).code).toBe('REPLAY_WINDOW_EXPIRED');
    }

    repo.close();
  });
});
