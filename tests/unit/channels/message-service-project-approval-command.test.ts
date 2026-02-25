import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { MessageService } from '@/server/channels/messages/service';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

const dispatchWithFallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    text: 'approval-command-model-response',
    provider: 'test-provider',
    model: 'test-model',
  })),
);
const dispatchSkillMock = vi.hoisted(() =>
  vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
);

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-key',
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: vi.fn(async () => {}),
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
    store: vi.fn(async () => ({ id: 'mem-1' })),
    updateFeedback: vi.fn(async () => {}),
  }),
}));

vi.mock('../../../src/server/personas/personaRepository', async () => {
  const actual = await vi.importActual('../../../src/server/personas/personaRepository');
  return {
    ...actual,
    getPersonaRepository: () => ({
      listPersonas: () => [],
      getPersona: () => null,
      getPersonaSystemInstruction: () => null,
    }),
  };
});

vi.mock('../../../src/server/skills/skillRepository', () => ({
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
    getSkill: () => null,
    setInstalled: () => true,
  }),
}));

vi.mock('../../../src/server/skills/executeSkill', async () => {
  const actual = await vi.importActual('../../../src/server/skills/executeSkill');
  return {
    ...actual,
    dispatchSkill: dispatchSkillMock,
  };
});

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: () => [
    {
      type: 'function',
      function: {
        name: 'shell_execute',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
  ],
}));

function getApprovalTokenFromMessage(metadataRaw: string | null): string {
  const metadata = JSON.parse(String(metadataRaw || '{}')) as {
    approvalToken?: string;
  };
  return String(metadata.approvalToken || '');
}

describe('MessageService /approve and /deny command flow', () => {
  let repo: SqliteMessageRepository;
  let service: MessageService;
  const previousApprovalsRequired = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;

  beforeEach(() => {
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    repo = new SqliteMessageRepository(':memory:');
    service = new MessageService(repo);
    dispatchWithFallbackMock.mockClear();
    dispatchSkillMock.mockClear();
  });

  it('approves a pending shell token via /approve <token>', async () => {
    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );
    const token = getApprovalTokenFromMessage(blocked.agentMsg.metadata);
    expect(token).not.toBe('');

    const approved = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      `/approve ${token}`,
      undefined,
      undefined,
      'user-1',
    );
    expect(String(approved.agentMsg.content)).toContain('approval-command-model-response');
    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo smoke' },
      expect.objectContaining({ bypassApproval: true }),
    );
  });

  it('denies a pending shell token via /deny <token>', async () => {
    const blocked = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/shell echo smoke',
      undefined,
      undefined,
      'user-1',
    );
    const token = getApprovalTokenFromMessage(blocked.agentMsg.metadata);
    expect(token).not.toBe('');

    const denied = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      `/deny ${token}`,
      undefined,
      undefined,
      'user-1',
    );
    expect(String(denied.agentMsg.content).toLowerCase()).toContain('abgelehnt');
    expect(dispatchSkillMock).not.toHaveBeenCalled();
  });

  it('returns token-not-found for unknown /approve tokens', async () => {
    const result = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/approve invalid-token',
      undefined,
      undefined,
      'user-1',
    );
    expect(String(result.agentMsg.content).toLowerCase()).toContain('nicht gefunden');
  });

  afterEach(() => {
    if (previousApprovalsRequired === undefined) {
      delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    } else {
      process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previousApprovalsRequired;
    }
  });
});
