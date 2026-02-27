import { describe, expect, it } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import { ToolManager } from '@/server/channels/messages/service/toolManager';

describe('ToolManager process_manager approvals', () => {
  it('returns approval_required for process_manager start when interactive approvals are enabled', async () => {
    const manager = new ToolManager(() => true);
    const marker = `tool-manager-proc-${Date.now()}`;
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
      functionName: 'process_manager',
      args: { action: 'start', command: `echo ${marker}` },
      installedFunctions: new Set(['process_manager']),
      toolId: 'process-manager',
    });

    expect(result.kind).toBe('approval_required');
    if (result.kind !== 'approval_required') {
      throw new Error(`Expected approval_required, got ${result.kind}`);
    }
    expect(result.pending.toolFunctionName).toBe('process_manager');
    expect(String(result.pending.command || '')).toContain(marker);
  });
});
