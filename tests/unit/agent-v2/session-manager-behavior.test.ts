import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import type {
  AgentCommand,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
  LifecycleHookOutcome,
  LifecycleHookStage,
} from '@/server/agent-v2/types';

const executionHarness = vi.hoisted(() => ({ executeCommand: vi.fn<MockProcedure>() }));
const broadcast = vi.hoisted(() => vi.fn<MockProcedure>());
const messageService = vi.hoisted(() => ({
  getConversation: vi.fn<MockProcedure>(),
  getOrCreateConversation: vi.fn<MockProcedure>(),
  setPersonaId: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/agent-v2/session/commands/execute', () => ({
  executeCommand: executionHarness.executeCommand,
}));
vi.mock('@/server/gateway/broadcast', () => ({ broadcastToUser: broadcast }));
vi.mock('@/server/channels/messages/runtime', () => ({ getMessageService: () => messageService }));

import { AgentV2SessionManager } from '@/server/agent-v2/session';
import type { MockProcedure } from '../../helpers/mockProcedure';

function makeSession(status: AgentSessionSnapshot['status'] = 'running'): AgentSessionSnapshot {
  return {
    id: 'session-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    status,
    revision: 1,
    lastSeq: 1,
    queueDepth: 0,
    runningCommandId: null,
    lastError: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    completedAt: null,
  };
}

function makeCommand(commandType: AgentCommand['commandType'] = 'input'): AgentCommand {
  return {
    id: 'command-1',
    sessionId: 'session-1',
    commandType,
    priority: 100,
    status: 'running',
    payload: { content: 'hello' },
    idempotencyKey: null,
    enqueuedAt: '2026-10-08T10:00:00.000Z',
    startedAt: '2026-10-08T10:00:01.000Z',
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    result: null,
  };
}

const event: AgentV2EventEnvelope = {
  schemaVersion: '2.1',
  eventId: 'event-1',
  sessionId: 'session-1',
  commandId: null,
  seq: 2,
  emittedAt: '2026-10-08T10:00:02.000Z',
  type: 'agent.v2.error',
  payload: {},
};

function createRepository(
  options: {
    commandType?: AgentCommand['commandType'];
    sessionStatus?: AgentSessionSnapshot['status'];
    reused?: boolean;
  } = {},
) {
  const currentSession = makeSession();
  const command = makeCommand(options.commandType);
  const started = { command, session: currentSession, events: [] as AgentV2EventEnvelope[] };
  return {
    currentSession,
    command,
    recoverRunningCommandsOnStartup: vi.fn<() => { recoveredCommands: number }>(() => ({
      recoveredCommands: 0,
    })),
    pruneExpiredEvents: vi.fn<MockProcedure>(),
    countQueuedCommands: vi.fn<() => number>(() => 0),
    enqueueCommand: vi.fn<
      () => {
        command: AgentCommand;
        reused: boolean;
        session: AgentSessionSnapshot;
        events: never[];
      }
    >(() => ({
      command,
      reused: options.reused ?? false,
      session: currentSession,
      events: [],
    })),
    startNextQueuedCommand: vi
      .fn<MockProcedure>()
      .mockReturnValueOnce(started)
      .mockReturnValue(null),
    getSession: vi.fn<() => AgentSessionSnapshot>(() => currentSession),
    completeCommand: vi.fn<
      () => { command: AgentCommand; session: AgentSessionSnapshot; events: never[] }
    >(() => ({
      command,
      session: makeSession(options.sessionStatus ?? 'running'),
      events: [],
    })),
    appendEvent: vi.fn<() => AgentV2EventEnvelope<Record<string, unknown>>>(() => event),
    createSession: vi.fn<() => { session: AgentSessionSnapshot; events: never[] }>(() => ({
      session: makeSession('idle'),
      events: [],
    })),
    listSessions: vi.fn<() => never[]>(() => []),
    replayEvents: vi.fn<() => never[]>(() => []),
    getCommandResult: vi.fn<() => null>(() => null),
    close: vi.fn<MockProcedure>(),
  };
}

function createExtensionHost(respond: (stage: string) => LifecycleHookOutcome[] = () => []) {
  return {
    refresh: vi.fn<MockProcedure>(),
    runHooks: vi.fn<(stage: string) => Promise<LifecycleHookOutcome[]>>(async (stage: string) =>
      respond(stage),
    ),
    stopAll: vi.fn<MockProcedure>(),
  };
}

async function waitForCommandCompletion(repository: ReturnType<typeof createRepository>) {
  await vi.waitFor(() => expect(repository.completeCommand).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(repository.startNextQueuedCommand).toHaveBeenCalledTimes(2));
}

describe('AgentV2SessionManager public behavior', () => {
  let originalExtensionsEnabled: string | undefined;

  beforeEach(() => {
    originalExtensionsEnabled = process.env.AGENT_V2_EXTENSIONS_ENABLED;
    executionHarness.executeCommand.mockReset();
    broadcast.mockReset();
    messageService.getConversation.mockReset();
    messageService.getOrCreateConversation.mockReset();
    messageService.setPersonaId.mockReset();
    delete process.env.AGENT_V2_EXTENSIONS_ENABLED;
  });

  afterEach(() => {
    if (originalExtensionsEnabled === undefined) {
      delete process.env.AGENT_V2_EXTENSIONS_ENABLED;
    } else {
      process.env.AGENT_V2_EXTENSIONS_ENABLED = originalExtensionsEnabled;
    }
  });

  it('constructs default dependencies safely, applies list limits, and closes resources', () => {
    process.env.AGENT_V2_EXTENSIONS_ENABLED = 'false';
    const defaultRepositoryHost = createExtensionHost();
    const originalDatabasePath = process.env.MESSAGES_DB_PATH;
    process.env.MESSAGES_DB_PATH = ':memory:';
    try {
      const defaultRepositoryManager = new AgentV2SessionManager(
        undefined,
        defaultRepositoryHost as unknown as AgentV2ExtensionHost,
      );
      expect(defaultRepositoryManager.listSessions('user-1')).toEqual([]);
      defaultRepositoryManager.close();
    } finally {
      if (originalDatabasePath === undefined) {
        delete process.env.MESSAGES_DB_PATH;
      } else {
        process.env.MESSAGES_DB_PATH = originalDatabasePath;
      }
    }

    const extensionHost = createExtensionHost();
    const repository = createRepository();
    const manager = new AgentV2SessionManager(
      repository as unknown as AgentV2Repository,
      extensionHost as unknown as AgentV2ExtensionHost,
    );
    manager.listSessions('user-1');
    manager.listSessions('user-1', 7);
    manager.close();

    expect(repository.listSessions).toHaveBeenNthCalledWith(1, 'user-1', 50);
    expect(repository.listSessions).toHaveBeenNthCalledWith(2, 'user-1', 7);
    expect(repository.close).toHaveBeenCalledOnce();
    expect(extensionHost.stopAll).toHaveBeenCalledOnce();

    const suppliedRepository = createRepository();
    const defaultHostManager = new AgentV2SessionManager(
      suppliedRepository as unknown as AgentV2Repository,
    );
    expect(suppliedRepository.recoverRunningCommandsOnStartup).toHaveBeenCalledOnce();
    defaultHostManager.close();
  });

  it('records a pre-creation hook failure as a warning and continues starting the session', async () => {
    const conversation: Conversation = {
      id: 'conversation-1',
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'web-1',
      userId: 'user-1',
      title: 'Session',
      modelOverride: null,
      personaId: null,
      createdAt: '2026-10-08T10:00:00.000Z',
      updatedAt: '2026-10-08T10:00:00.000Z',
    };
    messageService.getOrCreateConversation.mockReturnValue(conversation);
    const repository = createRepository();
    const extensionHost = createExtensionHost((stage) =>
      stage === 'session.before_start'
        ? [
            {
              ok: false,
              extensionId: 'broken',
              stage: 'session.before_start',
              durationMs: 1,
              policy: 'fail_open',
            },
          ]
        : [],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new AgentV2SessionManager(
      repository as unknown as AgentV2Repository,
      extensionHost as unknown as AgentV2ExtensionHost,
    );

    await expect(manager.startSession({ userId: 'user-1' })).resolves.toMatchObject({
      session: { id: 'session-1' },
    });

    expect(warn).toHaveBeenCalledWith(
      '[agent-v2] Hook failure before session creation (broken): unknown error',
    );
    expect(repository.createSession).toHaveBeenCalledOnce();
    expect(repository.appendEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'success',
      status: 'ok',
      commandStatus: 'completed',
      sessionStatus: 'completed',
      errorCode: null,
      message: 'done',
    },
    {
      name: 'command failure',
      status: 'error',
      commandStatus: 'failed_recoverable',
      sessionStatus: 'running',
      errorCode: 'COMMAND_EXECUTION_FAILED',
      message: 'rejected',
    },
  ] as const)(
    'completes a queued command after $name',
    async ({ status, commandStatus, sessionStatus, errorCode, message }) => {
      const repository = createRepository({ sessionStatus });
      const extensionHost = createExtensionHost();
      executionHarness.executeCommand.mockResolvedValue({
        status,
        message,
        metadata: { answer: 42 },
      });
      const manager = new AgentV2SessionManager(
        repository as unknown as AgentV2Repository,
        extensionHost as unknown as AgentV2ExtensionHost,
      );

      await manager.enqueueInput({ sessionId: 'session-1', userId: 'user-1', content: 'hello' });
      await waitForCommandCompletion(repository);

      expect(repository.completeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          status: commandStatus,
          errorCode,
          errorMessage: errorCode ? message : null,
        }),
      );
      if (sessionStatus === 'completed') {
        expect(extensionHost.runHooks).toHaveBeenCalledWith(
          'session.after_complete',
          expect.anything(),
        );
      }
    },
  );

  it.each([
    { thrown: new Error('runtime failure'), expectedMessage: 'runtime failure' },
    { thrown: 'runtime failure', expectedMessage: 'Command runtime exception.' },
  ])(
    'stores runtime exception details for $expectedMessage',
    async ({ thrown, expectedMessage }) => {
      const repository = createRepository();
      const extensionHost = createExtensionHost();
      executionHarness.executeCommand.mockRejectedValue(thrown);
      const manager = new AgentV2SessionManager(
        repository as unknown as AgentV2Repository,
        extensionHost as unknown as AgentV2ExtensionHost,
      );

      await manager.enqueueInput({ sessionId: 'session-1', userId: 'user-1', content: 'hello' });
      await waitForCommandCompletion(repository);

      expect(repository.completeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed_recoverable',
          errorCode: 'COMMAND_RUNTIME_EXCEPTION',
          errorMessage: expectedMessage,
        }),
      );
    },
  );

  it('marks abort completion, invokes completion hooks, and stops draining', async () => {
    const repository = createRepository({ commandType: 'abort', sessionStatus: 'aborted' });
    const extensionHost = createExtensionHost();
    executionHarness.executeCommand.mockResolvedValue({ status: 'ok', message: 'aborted' });
    const manager = new AgentV2SessionManager(
      repository as unknown as AgentV2Repository,
      extensionHost as unknown as AgentV2ExtensionHost,
    );

    await manager.enqueueAbort({ sessionId: 'session-1', userId: 'user-1' });
    await vi.waitFor(() => expect(repository.completeCommand).toHaveBeenCalledOnce());

    expect(extensionHost.runHooks).toHaveBeenCalledWith(
      'session.before_complete',
      expect.anything(),
    );
    expect(extensionHost.runHooks).toHaveBeenCalledWith(
      'session.after_complete',
      expect.anything(),
    );
    expect(repository.startNextQueuedCommand).toHaveBeenCalledOnce();
    expect(repository.completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted' }),
    );
  });

  it('records hook failures as error events and ignores overlapping queue drains', async () => {
    let releaseBeforeExecute: (() => void) | undefined;
    const beforeExecuteGate = new Promise<void>((resolve) => {
      releaseBeforeExecute = resolve;
    });
    const repository = createRepository();
    const extensionHost = createExtensionHost();
    extensionHost.runHooks.mockImplementation(async (stage: string) => {
      if (stage === 'command.before_execute') await beforeExecuteGate;
      if (stage === 'command.before_execute') {
        return [
          {
            ok: false,
            extensionId: 'execute-failed',
            stage: 'command.before_execute',
            error: 'hook failed',
            durationMs: 1,
            policy: 'fail_open',
          },
        ];
      }
      return stage === 'command.before_enqueue'
        ? [
            {
              ok: true,
              extensionId: 'ok',
              stage: stage as LifecycleHookStage,
              durationMs: 1,
              policy: 'fail_open',
            },
            {
              ok: false,
              extensionId: 'enqueue-failed',
              stage: stage as LifecycleHookStage,
              durationMs: 1,
              policy: 'fail_open',
            },
          ]
        : [];
    });
    executionHarness.executeCommand.mockImplementation(async (_command, _userId, context) => {
      await context.emitEphemeralEvent({
        sessionId: 'session-1',
        userId: 'user-1',
        type: 'agent.v2.model.delta',
        payload: { text: 'done' },
      });
      return { status: 'ok', message: 'done' };
    });
    const manager = new AgentV2SessionManager(
      repository as unknown as AgentV2Repository,
      extensionHost as unknown as AgentV2ExtensionHost,
    );

    await manager.enqueueInput({ sessionId: 'session-1', userId: 'user-1', content: 'hello' });
    await vi.waitFor(() =>
      expect(extensionHost.runHooks).toHaveBeenCalledWith(
        'command.before_execute',
        expect.anything(),
      ),
    );
    await manager.enqueueInput({ sessionId: 'session-1', userId: 'user-1', content: 'second' });
    expect(repository.startNextQueuedCommand).toHaveBeenCalledOnce();
    releaseBeforeExecute?.();
    await waitForCommandCompletion(repository);

    expect(repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: null,
        payload: expect.objectContaining({ message: 'Lifecycle hook failed.' }),
      }),
    );
    expect(repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'command-1',
        payload: expect.objectContaining({ message: 'hook failed' }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith('user-1', 'agent.v2.error', event, { protocol: 'v2' });
    expect(repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: null, type: 'agent.v2.model.delta' }),
    );
  });
});
