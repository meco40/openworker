import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { dispatchToAI } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import type { MockProcedure } from '../../helpers/mockProcedure';

describe('dispatchToAI summary refresh control', () => {
  const conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Chat',
    modelOverride: null,
    personaId: 'persona-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const runModelToolLoopMock = vi.fn<() => Promise<{ content: string; metadata: { ok: boolean } }>>(
    async () => ({
      content: 'ok',
      metadata: { ok: true },
    }),
  );
  const maybeRefreshConversationSummaryMock = vi.fn<() => Promise<void>>(async () => {});

  function createDeps() {
    return {
      contextBuilder: {
        buildGatewayMessages: vi.fn<() => { role: string; content: string }[]>(() => [
          { role: 'user', content: 'hello' },
        ]),
      },
      recallService: {
        buildRecallContext: vi.fn<() => Promise<null>>(async () => null),
      },
      summaryService: {
        maybeRefreshConversationSummary: maybeRefreshConversationSummaryMock,
      },
      toolManager: {
        resolveToolContext: vi.fn<
          () => Promise<{
            tools: never[];
            installedFunctionNames: Set<string>;
            functionToSkillId: Map<string, string>;
          }>
        >(async () => ({
          tools: [],
          installedFunctionNames: new Set<string>(),
          functionToSkillId: new Map<string, string>(),
        })),
      },
      resolveChatModelRouting: vi.fn<() => { modelHubProfileId: string }>(() => ({
        modelHubProfileId: 'p1',
      })),
      runModelToolLoop: runModelToolLoopMock,
      activeRequests: new Map<string, AbortController>(),
      resolveConversationWorkspaceCwd: vi.fn<MockProcedure>(),
    };
  }

  beforeEach(() => {
    runModelToolLoopMock.mockClear();
    maybeRefreshConversationSummaryMock.mockClear();
  });

  it('skips summary refresh when skipSummaryRefresh is true', async () => {
    const deps = createDeps();
    await dispatchToAI(deps as never, {
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userInput: 'erinner dich bitte',
      skipSummaryRefresh: true,
    });

    expect(runModelToolLoopMock).toHaveBeenCalledTimes(1);
    expect(maybeRefreshConversationSummaryMock).not.toHaveBeenCalled();
  });

  it('runs summary refresh by default', async () => {
    const deps = createDeps();
    await dispatchToAI(deps as never, {
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userInput: 'normale nachricht',
    });

    expect(runModelToolLoopMock).toHaveBeenCalledTimes(1);
    expect(maybeRefreshConversationSummaryMock).toHaveBeenCalledTimes(1);
  });
});
