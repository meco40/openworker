import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import { ToolManager } from '@/server/channels/messages/service/toolManager';
import {
  TOOL_APPROVAL_TTL_MS,
  TOOL_OUTPUT_MAX_CHARS,
} from '@/server/channels/messages/service/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

const mocks = vi.hoisted(() => ({
  approveCommand: vi.fn<MockProcedure>(),
  dispatchSkill: vi.fn<MockProcedure>(),
  getSkillRepository: vi.fn<MockProcedure>(),
  isCommandApproved: vi.fn<MockProcedure>(),
  mapSkillsToTools: vi.fn<MockProcedure>(),
  normalizeSkillArgs: vi.fn<(args: Record<string, unknown>) => Record<string, unknown>>(
    (args: Record<string, unknown>) => args,
  ),
}));

vi.mock('@/server/gateway/exec-approval-manager', () => ({
  approveCommand: mocks.approveCommand,
  isCommandApproved: mocks.isCommandApproved,
}));
vi.mock('@/server/skills/skillRepository', () => ({
  getSkillRepository: mocks.getSkillRepository,
}));
vi.mock('@/server/skills/executeSkill', () => ({
  dispatchSkill: mocks.dispatchSkill,
  normalizeSkillArgs: mocks.normalizeSkillArgs,
}));
vi.mock('@/skills/definitions', () => ({ mapSkillsToTools: mocks.mapSkillsToTools }));

const conversation: Conversation = {
  id: 'conversation-1',
  channelType: ChannelType.WEBCHAT,
  externalChatId: 'webchat-1',
  userId: 'user-1',
  title: 'Test',
  modelOverride: null,
  personaId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function call(
  functionName: string,
  args: Record<string, unknown> = {},
  overrides: { skipApprovalCheck?: boolean; installedFunctions?: Set<string> } = {},
) {
  return {
    conversation,
    platform: ChannelType.WEBCHAT,
    externalChatId: 'webchat-1',
    functionName,
    args,
    installedFunctions: overrides.installedFunctions ?? new Set([functionName]),
    workspaceCwd: '/workspace',
    toolId: 'tool-1',
    skipApprovalCheck: overrides.skipApprovalCheck,
  };
}

describe('ToolManager behavior', () => {
  beforeEach(() => {
    mocks.approveCommand.mockReset();
    mocks.dispatchSkill.mockReset().mockResolvedValue({ result: 'done' });
    mocks.getSkillRepository.mockReset().mockResolvedValue({ listSkills: () => [] });
    mocks.isCommandApproved.mockReset().mockReturnValue(false);
    mocks.mapSkillsToTools.mockReset().mockReturnValue([]);
    mocks.normalizeSkillArgs.mockClear();
  });

  it('formats strings and JSON, falls back for circular output, and marks truncation', () => {
    const manager = new ToolManager(() => false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(manager.formatToolOutput('  plain text  ')).toBe('plain text');
    expect(manager.formatToolOutput({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(manager.formatToolOutput(circular)).toBe('[object Object]');

    const longOutput = manager.formatToolOutput('x'.repeat(TOOL_OUTPUT_MAX_CHARS + 9));
    expect(longOutput).toHaveLength(TOOL_OUTPUT_MAX_CHARS + 120);
    expect(longOutput).toContain('9 chars omitted');
  });

  it('creates, looks up, prunes, and deletes pending approvals with metadata aliases', () => {
    const manager = new ToolManager(() => false);
    const expired = manager.createPendingApproval({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'webchat-1',
      toolFunctionName: 'shell_execute',
    });
    const fresh = manager.createPendingApproval({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'webchat-1',
      toolFunctionName: 'process_manager',
      args: { action: 'status' },
      command: 'process_manager status',
    });
    expired.createdAtMs = 1;
    manager.prunePendingToolApprovals(TOOL_APPROVAL_TTL_MS + 2);

    expect(expired.args).toEqual({});
    expect(manager.getPendingApproval(expired.token)).toBeUndefined();
    expect(manager.getPendingApproval(fresh.token)).toBe(fresh);
    expect(
      manager.buildApprovalMetadata(fresh, 'approve?', { origin: 'test', status: 'override' }),
    ).toMatchObject({
      origin: 'test',
      status: 'approval_required',
      approvalToken: fresh.token,
      approval_token: fresh.token,
      approvalPrompt: 'approve?',
      approval_prompt: 'approve?',
      approvalToolId: null,
      approvalToolFunction: 'process_manager',
    });
    expect(manager.deletePendingApproval(fresh.token)).toBe(true);
    expect(manager.deletePendingApproval(fresh.token)).toBe(false);
    expect(manager.buildToolApprovalPrompt('echo hi')).toContain('Command: echo hi');
  });

  it('maps only installed skill rows into the tool context', async () => {
    const rows = [
      {
        id: 'skill-installed',
        name: 'Installed',
        description: 'A test skill',
        category: 'utility',
        installed: true,
        version: '1.0',
        functionName: 'test_skill',
        source: 'local',
        sourceUrl: null,
      },
      {
        id: 'skill-missing',
        name: 'Missing',
        description: 'Not installed',
        category: 'utility',
        installed: false,
        version: '1.0',
        functionName: 'missing_skill',
        source: 'local',
      },
    ];
    const tools = [{ type: 'function', function: { name: 'test_skill' } }];
    mocks.getSkillRepository.mockResolvedValue({ listSkills: () => rows });
    mocks.mapSkillsToTools.mockReturnValue(tools);

    const result = await new ToolManager(() => false).resolveToolContext();

    expect(result).toEqual({
      tools,
      installedFunctionNames: new Set(['test_skill']),
      functionToSkillId: new Map([['test_skill', 'skill-installed']]),
    });
    expect(mocks.mapSkillsToTools).toHaveBeenCalledWith(
      [expect.objectContaining({ sourceUrl: undefined, functionName: 'test_skill' })],
      'openai',
    );
  });

  it('rejects missing, empty, unsafe, or invalid CLI requests before dispatch', async () => {
    const manager = new ToolManager(() => false);
    const cases = [
      [
        call('unknown_tool', {}, { installedFunctions: new Set() }),
        'Tool "unknown_tool" ist nicht installiert.',
      ],
      [call('exec', { command: '   ' }), 'shell_execute requires command.'],
      [
        call('process_manager', { action: 'start' }),
        'process_manager action=start requires command.',
      ],
      [call('playwright_cli', { args: ['connect'] }), 'Unsupported Playwright CLI subcommand'],
      [
        call('shell_execute', { command: 'rm -rf /tmp/test' }),
        'Command blocked by security policy.',
      ],
    ] as const;

    for (const [params, expected] of cases) {
      const result = await manager.executeToolFunctionCall(params);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.output).toContain(expected);
    }
    expect(mocks.dispatchSkill).not.toHaveBeenCalled();
  });

  it('dispatches allowed commands with runtime context and supports approval bypass', async () => {
    const manager = new ToolManager(() => true);

    const result = await manager.executeToolFunctionCall(
      call('exec', { command: ' echo safe ' }, { skipApprovalCheck: true }),
    );

    expect(result).toEqual({ kind: 'ok', output: '{\n  "result": "done"\n}' });
    expect(mocks.dispatchSkill).toHaveBeenCalledWith(
      'exec',
      { command: ' echo safe ' },
      expect.objectContaining({
        bypassApproval: true,
        enforceSkillActivation: true,
        workspaceCwd: '/workspace',
        conversationId: 'conversation-1',
        userId: 'user-1',
        platform: ChannelType.WEBCHAT,
        externalChatId: 'webchat-1',
        invokeSubagentToolCall: undefined,
      }),
    );
  });

  it('uses stored command approvals and returns dispatch failures as tool errors', async () => {
    const manager = new ToolManager(() => true);
    mocks.isCommandApproved.mockReturnValue(true);

    const result = await manager.executeToolFunctionCall(
      call('shell_execute', { command: 'echo safe' }),
    );
    expect(result.kind).toBe('ok');
    expect(mocks.isCommandApproved).toHaveBeenCalledWith('echo safe');

    mocks.dispatchSkill.mockRejectedValueOnce(new Error('skill failed'));
    await expect(
      manager.executeToolFunctionCall(call('read_file', { path: 'missing.txt' })),
    ).resolves.toEqual({ kind: 'error', output: 'skill failed' });

    mocks.dispatchSkill.mockRejectedValueOnce('non-error failure');
    await expect(
      manager.executeToolFunctionCall(call('read_file', { path: 'missing.txt' })),
    ).resolves.toEqual({ kind: 'error', output: 'non-error failure' });
  });

  it('allows non-start process actions and records explicit command approvals', async () => {
    const manager = new ToolManager(() => false);

    const result = await manager.executeToolFunctionCall(call('process', { action: 'status' }));
    expect(result.kind).toBe('ok');
    expect(mocks.dispatchSkill).toHaveBeenCalledWith(
      'process',
      { action: 'status' },
      expect.objectContaining({ bypassApproval: false }),
    );

    await manager.approveCommand('echo approved');
    expect(mocks.approveCommand).toHaveBeenCalledWith('echo approved');
  });
});
