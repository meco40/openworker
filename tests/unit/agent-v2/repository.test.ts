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

  it('completes queued commands with fallback errors, results, and terminal events', () => {
    const repo = new AgentV2Repository(':memory:');
    const created = repo.createSession({
      userId: 'user-complete',
      conversationId: 'conv-complete',
    });

    try {
      expect(repo.startNextQueuedCommand(created.session.id, 'user-complete')).toBeNull();
      expect(repo.hasQueuedAbort(created.session.id)).toBe(false);

      const failedCommand = repo.enqueueCommand({
        sessionId: created.session.id,
        userId: 'user-complete',
        commandType: 'input',
        priority: 100,
        payload: { content: 'fail this command' },
      });
      const abortCommand = repo.enqueueCommand({
        sessionId: created.session.id,
        userId: 'user-complete',
        commandType: 'abort',
        priority: 50,
        payload: {},
      });
      expect(repo.hasQueuedAbort(created.session.id)).toBe(true);
      expect(repo.countQueuedCommands(created.session.id, 'user-complete')).toBe(2);

      const started = repo.startNextQueuedCommand(created.session.id, 'user-complete');
      expect(started?.command.id).toBe(failedCommand.command.id);
      const failed = repo.completeCommand({
        sessionId: created.session.id,
        userId: 'user-complete',
        commandId: failedCommand.command.id,
        status: 'failed',
      });
      expect(failed.session.status).toBe('error');
      expect(failed.command).toMatchObject({
        errorCode: null,
        errorMessage: null,
        result: null,
      });
      expect(failed.events.map(({ type }) => type)).toContain('agent.v2.error');
      expect(failed.events.map(({ payload }) => payload)).toContainEqual(
        expect.objectContaining({ errorCode: 'COMMAND_FAILED', message: 'Command failed.' }),
      );
      expect(failed.events.map(({ type }) => type)).not.toContain('agent.v2.session.completed');

      const startedAbort = repo.startNextQueuedCommand(created.session.id, 'user-complete');
      expect(startedAbort?.command.id).toBe(abortCommand.command.id);
      const aborted = repo.completeCommand({
        sessionId: created.session.id,
        userId: 'user-complete',
        commandId: abortCommand.command.id,
        status: 'aborted',
        result: { cancelled: true },
        errorCode: null,
        errorMessage: null,
      });
      expect(aborted.session).toMatchObject({ status: 'aborted' });
      expect(aborted.command.result).toEqual({ cancelled: true });
      expect(aborted.events.map(({ type }) => type)).toContain('agent.v2.command.completed');
      expect(aborted.events.map(({ type }) => type)).toContain('agent.v2.session.completed');

      const recoverable = repo.createSession({
        userId: 'user-recoverable',
        conversationId: 'conv-recoverable',
      });
      const recoverableCommand = repo.enqueueCommand({
        sessionId: recoverable.session.id,
        userId: 'user-recoverable',
        commandType: 'input',
        priority: 1,
        payload: {},
      });
      repo.startNextQueuedCommand(recoverable.session.id, 'user-recoverable');
      const recoverableResult = repo.completeCommand({
        sessionId: recoverable.session.id,
        userId: 'user-recoverable',
        commandId: recoverableCommand.command.id,
        status: 'failed_recoverable',
        errorCode: 'TEMPORARY_FAILURE',
        errorMessage: 'Try again.',
        result: { retryable: true },
      });
      expect(recoverableResult.session.status).toBe('error_recoverable');
      expect(recoverableResult.events.map(({ type }) => type)).toContain('agent.v2.error');
      expect(recoverableResult.events.map(({ payload }) => payload)).toContainEqual(
        expect.objectContaining({ errorCode: 'TEMPORARY_FAILURE', message: 'Try again.' }),
      );
    } finally {
      repo.close();
    }
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
