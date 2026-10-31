import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';

const buildActiveSkillsPromptSectionMock = vi.hoisted(() =>
  vi.fn<() => string>(() => 'ACTIVE SKILLS BLOCK'),
);

vi.mock('@/server/channels/messages/service/dispatchers/skillsPrompt', () => ({
  buildActiveSkillsPromptSection: buildActiveSkillsPromptSectionMock,
}));

vi.mock('@/server/skills/skillMd/index', () => ({
  loadAllSkillMd: () => [],
  filterEligibleSkills: () => [],
}));

vi.mock('@/server/skills/builtInSkills', () => ({
  BUILT_IN_SKILLS: [],
}));

vi.mock('@/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'shell-access',
        name: 'Safe Shell',
        description: 'Shell skill',
        category: 'Automation',
        version: '1.0.0',
        installed: true,
        functionName: 'shell_execute',
        source: 'built-in',
        sourceUrl: null,
      },
    ],
  }),
}));

import { dispatchToAI } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import type { MockProcedure } from '../../helpers/mockProcedure';

describe('dispatchToAI toolsDisabled behavior', () => {
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

  const runModelToolLoopMock = vi.fn<
    (
      _toolManager: unknown,
      _params: { messages: Array<{ content: string }>; toolContext: { tools: unknown[] } },
    ) => Promise<{ content: string; metadata: { ok: boolean } }>
  >(async () => ({
    content: 'ok',
    metadata: { ok: true },
  }));

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
        maybeRefreshConversationSummary: vi.fn<() => Promise<void>>(async () => {}),
      },
      toolManager: {
        resolveToolContext: vi.fn<MockProcedure>(async () => ({
          tools: [{ type: 'function', function: { name: 'shell_execute' } }],
          installedFunctionNames: new Set<string>(['shell_execute']),
          functionToSkillId: new Map<string, string>([['shell_execute', 'shell-access']]),
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
    buildActiveSkillsPromptSectionMock.mockClear();
  });

  it('does not inject active-skills section when tools are disabled', async () => {
    const deps = createDeps();
    await dispatchToAI(deps as never, {
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userInput: 'roleplay message',
      toolsDisabled: true,
    });

    expect(buildActiveSkillsPromptSectionMock).not.toHaveBeenCalled();
    const loopParams = runModelToolLoopMock.mock.calls[0]?.[1];
    const messageContents = loopParams?.messages?.map((entry) => entry.content) ?? [];
    expect(messageContents).not.toContain('ACTIVE SKILLS BLOCK');
    expect(loopParams?.toolContext?.tools).toEqual([]);
  });
});
