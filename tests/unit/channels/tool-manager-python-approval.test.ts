import { describe, expect, it } from 'vitest';
import { ToolManager } from '@/server/channels/messages/service/toolManager';
import { ChannelType } from '@/shared/domain/types';

describe('Python interactive approval', () => {
  it('returns an interactive approval before dispatching Python code', async () => {
    const manager = new ToolManager(() => true);
    const result = await manager.executeToolFunctionCall({
      conversation: {
        id: 'release-approval',
        userId: 'release-user',
        title: 'Release',
        externalChatId: null,
        modelOverride: null,
        personaId: null,
        channelType: ChannelType.WEBCHAT,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      platform: ChannelType.WEBCHAT,
      externalChatId: 'release-approval',
      functionName: 'python_execute',
      args: { code: 'print("unapproved")' },
      installedFunctions: new Set(['python_execute']),
    });
    expect(result.kind).toBe('approval_required');
  });
});
