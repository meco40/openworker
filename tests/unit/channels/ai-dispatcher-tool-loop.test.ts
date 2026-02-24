import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { runModelToolLoop } from '@/server/channels/messages/service/dispatchers/aiDispatcher';
import { MAX_TOOL_ROUNDS } from '@/server/channels/messages/service/types';

const dispatchWithFallbackMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-key',
}));

describe('runModelToolLoop', () => {
  const conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Chat',
    modelOverride: null,
    personaId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const toolManager = {
    executeToolFunctionCall: vi.fn(async () => ({ kind: 'ok' as const, output: 'tool-output' })),
    buildApprovalMetadata: vi.fn(),
  };

  const toolContext = {
    tools: [],
    installedFunctionNames: new Set(['shell_execute']),
    functionToSkillId: new Map([['shell_execute', 'shell-access']]),
  };

  beforeEach(() => {
    dispatchWithFallbackMock.mockReset();
    toolManager.executeToolFunctionCall.mockClear();
  });

  it('returns tool_limit_reached instead of empty response when model keeps requesting tools', async () => {
    dispatchWithFallbackMock.mockImplementation(async () => ({
      ok: true,
      text: '',
      provider: 'test-provider',
      model: 'test-model',
      functionCalls: [{ name: 'shell_execute', args: { command: 'echo hello' } }],
    }));

    const result = await runModelToolLoop(toolManager as never, {
      conversation,
      messages: [{ role: 'user', content: 'build app' }],
      modelHubProfileId: 'p1',
      toolContext,
    });

    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.status).toBe('tool_limit_reached');
    expect(result.content.toLowerCase()).toContain('max tool calls');
    expect(toolManager.executeToolFunctionCall).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
  });

  it('returns empty_model_response when provider returns no text and no tool calls', async () => {
    dispatchWithFallbackMock.mockResolvedValue({
      ok: true,
      text: '',
      provider: 'test-provider',
      model: 'test-model',
    });

    const result = await runModelToolLoop(toolManager as never, {
      conversation,
      messages: [{ role: 'user', content: 'hi' }],
      modelHubProfileId: 'p1',
      toolContext,
    });

    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.status).toBe('empty_model_response');
    expect(result.content.toLowerCase()).toContain('no text output');
  });

  it('honors maxToolCalls override for longer autonomous execution loops', async () => {
    let round = 0;
    dispatchWithFallbackMock.mockImplementation(async () => {
      round += 1;
      if (round <= 4) {
        return {
          ok: true,
          text: '',
          provider: 'test-provider',
          model: 'test-model',
          functionCalls: [{ name: 'shell_execute', args: { command: `echo step-${round}` } }],
        };
      }
      return {
        ok: true,
        text: 'autonomous task complete',
        provider: 'test-provider',
        model: 'test-model',
      };
    });

    const result = await runModelToolLoop(toolManager as never, {
      conversation,
      messages: [{ role: 'user', content: 'build app end-to-end' }],
      modelHubProfileId: 'p1',
      toolContext,
      maxToolCalls: 6,
    });

    expect(result.metadata.ok).toBe(true);
    expect(result.content).toContain('autonomous task complete');
    expect(toolManager.executeToolFunctionCall).toHaveBeenCalledTimes(4);
  });

  it('stops early when identical failing tool calls repeat without progress', async () => {
    dispatchWithFallbackMock.mockImplementation(async () => ({
      ok: true,
      text: '',
      provider: 'test-provider',
      model: 'test-model',
      functionCalls: [{ name: 'shell_execute', args: { command: 'npm install' } }],
    }));
    toolManager.executeToolFunctionCall.mockImplementation(
      async () => ({ kind: 'error', output: 'command timed out' }) as never,
    );

    const result = await runModelToolLoop(toolManager as never, {
      conversation,
      messages: [{ role: 'user', content: 'create app' }],
      modelHubProfileId: 'p1',
      toolContext,
      maxToolCalls: 120,
    });

    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.status).toBe('tool_stuck_repetition');
    expect(String(result.content).toLowerCase()).toContain('endless retry loop');
    expect(toolManager.executeToolFunctionCall).toHaveBeenCalledTimes(4);
  });
});
