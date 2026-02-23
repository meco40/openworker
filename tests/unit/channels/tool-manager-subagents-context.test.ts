import { describe, expect, it } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import { ToolManager } from '@/server/channels/messages/service/toolManager';

describe('ToolManager subagents context bridge', () => {
  it('forwards invokeSubagentToolCall so subagents skill can run in tool runtime', async () => {
    const manager = new ToolManager(
      () => false,
      async () => ({
        status: 'ok',
        text: 'subagent bridge works',
      }),
    );

    const conversation: Conversation = {
      id: 'conv-1',
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'user-1',
      title: 'Test',
      modelOverride: null,
      personaId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'subagents',
      args: { action: 'list' },
      installedFunctions: new Set(['subagents']),
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      throw new Error(`Expected ok result, got ${result.kind}`);
    }
    expect(result.output).toContain('subagent bridge works');
    expect(result.output).not.toContain('unavailable in current runtime context');
  });
});
