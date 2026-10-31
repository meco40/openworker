import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import type {
  AgentCommand,
  AgentSessionSnapshot,
  AgentV2EventEnvelope,
} from '@/server/agent-v2/types';
import type { ExecuteContext } from '@/server/agent-v2/session/commands/execute';

type ApprovalStatus = 'approved' | 'denied' | 'not_found' | 'approval_required';
type ApprovalInput = {
  conversationId: string;
  userId: string;
  approvalToken: string;
  approved: boolean;
  approveAlways: boolean;
  toolId?: string;
  toolFunctionName?: string;
};
type MessageResult = {
  userMsg: { id: string };
  agentMsg: { id: string; content: string; metadata: string | null };
  newConversationId?: string | null;
};
type HandleMessage = (
  conversationId: string,
  content: string,
  userId: string,
  tools?: undefined,
  attachments?: undefined,
  onDelta?: (delta: string) => void,
  options?: { skipProjectGuard: boolean },
) => Promise<MessageResult>;

const messageServiceMock = vi.hoisted(() => ({
  abortGeneration: vi.fn<(conversationId: string) => boolean>(),
  respondToolApproval: vi.fn<
    (input: ApprovalInput) => Promise<{
      status: ApprovalStatus;
      policyUpdated?: boolean;
    }>
  >(),
  handleWebUIMessage: vi.fn<HandleMessage>(),
}));

vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageService: () => messageServiceMock,
}));

import { executeCommand } from '@/server/agent-v2/session/commands/execute';
import type { MockProcedure } from '../../helpers/mockProcedure';

const session: AgentSessionSnapshot = {
  id: 'session-1',
  userId: 'user-1',
  conversationId: 'conversation-1',
  status: 'running',
  revision: 2,
  lastSeq: 4,
  queueDepth: 0,
  runningCommandId: 'command-1',
  lastError: null,
  createdAt: '2026-10-08T09:00:00.000Z',
  updatedAt: '2026-10-08T09:00:00.000Z',
  completedAt: null,
};

function command(
  commandType: AgentCommand['commandType'],
  payload: Record<string, unknown> = {},
): AgentCommand {
  return {
    id: 'command-1',
    sessionId: session.id,
    commandType,
    priority: 100,
    status: 'running',
    payload,
    idempotencyKey: null,
    enqueuedAt: '2026-10-08T09:00:00.000Z',
    startedAt: '2026-10-08T09:00:01.000Z',
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    result: null,
  };
}

function createContext() {
  const persistedEvent: AgentV2EventEnvelope = {
    schemaVersion: '2.1',
    eventId: 'event-1',
    sessionId: session.id,
    commandId: 'command-1',
    seq: 5,
    emittedAt: '2026-10-08T09:00:02.000Z',
    type: 'agent.v2.approval.required',
    payload: {},
  };
  const repository = {
    appendEvent: vi.fn<() => AgentV2EventEnvelope<Record<string, unknown>>>(() => persistedEvent),
    hasQueuedAbort: vi.fn<() => boolean>(() => false),
  };
  const emitEphemeralEvent = vi.fn<
    (_event: Parameters<ExecuteContext['emitEphemeralEvent']>[0]) => Promise<void>
  >(async (_event: Parameters<ExecuteContext['emitEphemeralEvent']>[0]) => {});
  const context = {
    repository: repository as unknown as AgentV2Repository,
    extensionHost: {} as AgentV2ExtensionHost,
    activeHandles: new Map(),
    getSession: vi.fn<() => AgentSessionSnapshot>(() => session),
    runHooks: vi.fn<(_stage: string, _context: unknown) => Promise<void>>(
      async (_stage: string, _context: unknown) => {},
    ),
    emitPersistedEvents: vi.fn<MockProcedure>(),
    emitEphemeralEvent,
  } satisfies ExecuteContext;
  return { context, repository, persistedEvent };
}

describe('Agent V2 command execution', () => {
  beforeEach(() => {
    messageServiceMock.abortGeneration.mockReset().mockReturnValue(false);
    messageServiceMock.respondToolApproval.mockReset().mockResolvedValue({
      status: 'approved',
      policyUpdated: false,
    });
    messageServiceMock.handleWebUIMessage.mockReset().mockResolvedValue({
      userMsg: { id: 'user-message-1' },
      agentMsg: { id: 'agent-message-1', content: 'completed', metadata: null },
    });
  });

  it.each([
    { aborted: true, message: 'Abort signal sent.' },
    { aborted: false, message: 'No in-flight command to abort.' },
  ])('reports the abort result when aborted=$aborted', async ({ aborted, message }) => {
    messageServiceMock.abortGeneration.mockReturnValue(aborted);
    const { context } = createContext();

    await expect(executeCommand(command('abort'), 'user-1', context)).resolves.toEqual({
      status: 'ok',
      message,
      metadata: { aborted },
    });
    expect(messageServiceMock.abortGeneration).toHaveBeenCalledWith(session.conversationId);
    expect(context.getSession).toHaveBeenCalledWith(session.id, 'user-1');
  });

  it('rejects an approval without a token before reaching the message service', async () => {
    const { context } = createContext();

    await expect(
      executeCommand(command('approval', { approvalToken: '  ' }), 'user-1', context),
    ).resolves.toEqual({ status: 'error', message: 'approvalToken is required.' });
    expect(messageServiceMock.respondToolApproval).not.toHaveBeenCalled();
  });

  it('records follow-up approval requirements and forwards approval choices', async () => {
    messageServiceMock.respondToolApproval.mockResolvedValueOnce({
      status: 'approval_required',
      policyUpdated: true,
    });
    const { context, repository, persistedEvent } = createContext();

    await expect(
      executeCommand(
        command('approval', {
          approvalToken: ' token-7 ',
          approved: true,
          approveAlways: 1,
          toolId: 42,
          toolFunctionName: 'run-command',
        }),
        'user-1',
        context,
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      message: 'Another approval step is required.',
      metadata: { status: 'approval_required', policyUpdated: true },
    });
    expect(messageServiceMock.respondToolApproval).toHaveBeenCalledWith({
      conversationId: session.conversationId,
      userId: 'user-1',
      approvalToken: 'token-7',
      approved: true,
      approveAlways: true,
      toolId: '42',
      toolFunctionName: 'run-command',
    });
    expect(repository.appendEvent).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: 'user-1',
      commandId: 'command-1',
      type: 'agent.v2.approval.required',
      payload: { approvalToken: 'token-7', reason: 'Further approval is required.' },
    });
    expect(context.emitPersistedEvents).toHaveBeenCalledWith('user-1', [persistedEvent]);
  });

  it.each([
    { status: 'approved' as const, resultStatus: 'ok', message: 'Approval command accepted.' },
    { status: 'denied' as const, resultStatus: 'ok', message: 'Approval denied.' },
    { status: 'not_found' as const, resultStatus: 'error', message: 'Approval token not found.' },
  ])('maps approval status $status to the public command result', async (reply) => {
    messageServiceMock.respondToolApproval.mockResolvedValueOnce({
      status: reply.status,
      policyUpdated: false,
    });
    const { context, repository } = createContext();

    await expect(
      executeCommand(command('approval', { approvalToken: 'token' }), 'user-1', context),
    ).resolves.toMatchObject({ status: reply.resultStatus, message: reply.message });
    expect(repository.appendEvent).not.toHaveBeenCalled();
  });

  it('rejects content commands with empty input before hooks or dispatch', async () => {
    const { context } = createContext();

    await expect(
      executeCommand(command('input', { content: '  ' }), 'user-1', context),
    ).resolves.toEqual({ status: 'error', message: 'input requires non-empty content.' });
    expect(context.runHooks).not.toHaveBeenCalled();
    expect(messageServiceMock.handleWebUIMessage).not.toHaveBeenCalled();
  });

  it('dispatches trimmed content and publishes tool/model stream events', async () => {
    const { context, repository } = createContext();
    repository.hasQueuedAbort.mockReturnValue(true);
    messageServiceMock.handleWebUIMessage.mockImplementationOnce(
      async (_conversationId, _content, _userId, _tools, _attachments, onDelta) => {
        onDelta?.('\u0000tc: search');
        onDelta?.('partial answer');
        onDelta?.('\u0000tc:');
        onDelta?.(7 as unknown as string);
        return {
          userMsg: { id: 'user-message-1' },
          agentMsg: { id: 'agent-message-1', content: 'done', metadata: 'invalid json' },
          newConversationId: '',
        };
      },
    );

    await expect(
      executeCommand(command('steer', { content: '  continue  ' }), 'user-1', context),
    ).resolves.toEqual({
      status: 'ok',
      message: 'done',
      metadata: {
        userMessageId: 'user-message-1',
        agentMessageId: 'agent-message-1',
        newConversationId: null,
        status: 'ok',
      },
    });
    expect(messageServiceMock.handleWebUIMessage).toHaveBeenCalledWith(
      session.conversationId,
      'continue',
      'user-1',
      undefined,
      undefined,
      expect.any(Function),
      { skipProjectGuard: true },
    );
    expect(context.runHooks.mock.calls.map(([stage]) => stage)).toEqual(
      expect.arrayContaining([
        'model.before_dispatch',
        'tool.before_execute',
        'tool.after_execute',
        'model.after_dispatch',
      ]),
    );
    expect(context.emitEphemeralEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'agent.v2.tool.started',
      'agent.v2.model.delta',
      'agent.v2.tool.completed',
    ]);
    expect(repository.hasQueuedAbort).toHaveBeenCalledWith(session.id);
    expect(messageServiceMock.abortGeneration).toHaveBeenCalledWith(session.conversationId);
  });

  it('persists and hooks a tool approval requirement returned by model dispatch', async () => {
    const { context, repository, persistedEvent } = createContext();
    messageServiceMock.handleWebUIMessage.mockResolvedValueOnce({
      userMsg: { id: 'user-message-2' },
      agentMsg: {
        id: 'agent-message-2',
        content: 'Waiting for approval.',
        metadata: JSON.stringify({ status: 'approval_required', approvalToken: 'token-8' }),
      },
      newConversationId: 'conversation-2',
    });

    await expect(
      executeCommand(command('follow_up', { content: 'run deployment' }), 'user-1', context),
    ).resolves.toMatchObject({
      status: 'ok',
      metadata: {
        newConversationId: 'conversation-2',
        status: 'approval_required',
      },
    });
    expect(repository.appendEvent).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: 'user-1',
      commandId: 'command-1',
      type: 'agent.v2.approval.required',
      payload: { status: 'approval_required', approvalToken: 'token-8' },
    });
    expect(context.emitPersistedEvents).toHaveBeenCalledWith('user-1', [persistedEvent]);
    expect(context.runHooks.mock.calls.map(([stage]) => stage)).toContain('approval.required');
  });
});
