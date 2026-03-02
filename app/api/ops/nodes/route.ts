import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runDoctorCommand } from '@/commands/doctorCommand';
import { runHealthCommand } from '@/commands/healthCommand';
import type { OpsNodeChannelSummary, OpsNodesResponse } from '@/modules/ops/types';
import { CHANNEL_CAPABILITIES } from '@/server/channels/adapters/capabilities';
import type { ChannelKey } from '@/server/channels/adapters/types';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import {
  normalizeBridgeAccountId,
  listBridgeAccounts,
  upsertBridgeAccount,
} from '@/server/channels/pairing/bridgeAccounts';
import { isPairChannelType, pairChannel, unpairChannel } from '@/server/channels/pairing';
import {
  getTelegramPairingSnapshot,
  rejectTelegramPendingPairingRequest,
} from '@/server/channels/pairing/telegramCodePairing';
import { getAutomationService } from '@/server/automation/runtime';
import {
  approveCommand,
  clearApprovedCommands,
  listApprovedCommands,
  revokeCommand,
} from '@/server/gateway/exec-approval-manager';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_CHANNEL_LIMIT = 50;
const MIN_CHANNEL_LIMIT = 1;
const MAX_CHANNEL_LIMIT = 200;

type NodesMutationRequest = {
  action?: unknown;
  command?: unknown;
  channel?: unknown;
  personaId?: unknown;
  token?: unknown;
  accountId?: unknown;
};

class NodesActionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseChannelLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_CHANNEL_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHANNEL_LIMIT;
  }

  return Math.min(Math.max(parsed, MIN_CHANNEL_LIMIT), MAX_CHANNEL_LIMIT);
}

function parseMemoryDiagnosticsEnabled(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get('memoryDiagnostics');
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function parseString(
  value: unknown,
  fieldName: string,
  { required = true }: { required?: boolean } = {},
): string | null {
  if (typeof value !== 'string') {
    if (required) {
      throw new NodesActionError(`${fieldName} must be a string.`);
    }
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      throw new NodesActionError(`${fieldName} is required.`);
    }
    return null;
  }
  return trimmed;
}

function parseChannelKey(value: unknown): ChannelKey {
  const channel = parseString(value, 'channel');
  if (!channel || !(channel in CHANNEL_CAPABILITIES)) {
    throw new NodesActionError('Unsupported channel.');
  }
  return channel as ChannelKey;
}

async function buildNodesPayload(
  userId: string,
  options: {
    memoryDiagnosticsEnabled: boolean;
    channelLimit: number;
    mutation?: OpsNodesResponse['mutation'];
  },
): Promise<OpsNodesResponse> {
  const [health, doctor] = await Promise.all([
    runHealthCommand({ memoryDiagnosticsEnabled: options.memoryDiagnosticsEnabled }),
    runDoctorCommand({ memoryDiagnosticsEnabled: options.memoryDiagnosticsEnabled }),
  ]);

  const messageRepo = getMessageRepository();
  const bindingRows = messageRepo.listChannelBindings?.(userId) || [];
  const bindingByChannel = new Map(bindingRows.map((row) => [row.channel, row]));

  const channels: OpsNodeChannelSummary[] = Object.entries(CHANNEL_CAPABILITIES)
    .map(([channel, capabilities]) => {
      const binding = bindingByChannel.get(channel as ChannelKey);
      const accounts =
        channel === 'whatsapp' || channel === 'imessage' ? listBridgeAccounts(channel) : undefined;

      return {
        channel,
        status: binding?.status ?? 'idle',
        externalPeerId: binding?.externalPeerId ?? null,
        peerName: binding?.peerName ?? null,
        transport: binding?.transport ?? null,
        personaId: binding?.personaId ?? null,
        lastSeenAt: binding?.lastSeenAt ?? null,
        supportsInbound: capabilities.supportsInbound,
        supportsOutbound: capabilities.supportsOutbound,
        supportsPairing: capabilities.supportsPairing,
        supportsStreaming: capabilities.supportsStreaming,
        ...(accounts ? { accounts } : {}),
      };
    })
    .slice(0, options.channelLimit);

  const personas = getPersonaRepository()
    .listPersonas(userId)
    .map((persona) => ({
      id: persona.id,
      name: persona.name,
      emoji: persona.emoji,
      vibe: persona.vibe,
      updatedAt: persona.updatedAt,
    }));

  const approvals = listApprovedCommands();

  return {
    ok: true,
    ...(options.mutation ? { mutation: options.mutation } : {}),
    nodes: {
      health: {
        status: health.status,
        summary: health.summary,
        generatedAt: health.generatedAt,
      },
      doctor: {
        status: doctor.status,
        findings: doctor.findings.length,
        recommendations: doctor.recommendations.length,
        generatedAt: doctor.generatedAt,
      },
      channels,
      automation: getAutomationService().getMetrics(),
      personas,
      execApprovals: {
        total: approvals.length,
        items: approvals.map((entry) => ({
          fingerprint: entry.fingerprint,
          command: entry.command,
          updatedAt: entry.updatedAt,
        })),
      },
      telegramPairing: getTelegramPairingSnapshot(),
      generatedAt: new Date().toISOString(),
    },
  };
}

type MutationHandler = (
  userId: string,
  body: NodesMutationRequest,
) => Promise<OpsNodesResponse['mutation']>;

const handleExecApprove: MutationHandler = async (_userId, body) => {
  const command = parseString(body.command, 'command');
  approveCommand(command as string);
  return { action: 'exec.approve', command };
};

const handleExecRevoke: MutationHandler = async (_userId, body) => {
  const command = parseString(body.command, 'command');
  return {
    action: 'exec.revoke',
    command,
    revoked: revokeCommand(command as string),
  };
};

const handleExecClear: MutationHandler = async () => {
  clearApprovedCommands();
  return { action: 'exec.clear', cleared: true };
};

const handleBindingsSetPersona: MutationHandler = async (userId, body) => {
  const channel = parseChannelKey(body.channel);
  const rawPersonaId = typeof body.personaId === 'string' ? body.personaId.trim() : '';
  const personaId = rawPersonaId || null;

  if (personaId) {
    const personas = getPersonaRepository().listPersonas(userId);
    if (!personas.some((persona) => persona.id === personaId)) {
      throw new NodesActionError('Unknown personaId.');
    }
  }

  const repo = getMessageRepository();
  if (!repo.updateChannelBindingPersona) {
    throw new NodesActionError('Channel binding persona updates are unavailable.');
  }
  repo.updateChannelBindingPersona(userId, channel, personaId);
  return { action: 'bindings.setPersona', channel, personaId };
};

const handleChannelsConnect: MutationHandler = async (_userId, body) => {
  const channel = parseString(body.channel, 'channel');
  if (!channel || !isPairChannelType(channel)) {
    throw new NodesActionError('Unsupported channel for pairing.');
  }
  const token = typeof body.token === 'string' ? body.token : '';
  const accountId = parseString(body.accountId, 'accountId', { required: false });
  const paired = await pairChannel(channel, token, accountId || undefined);

  const status =
    paired && typeof paired === 'object' && 'status' in paired && typeof paired.status === 'string'
      ? paired.status
      : 'connected';

  return {
    action: 'channels.connect',
    channel,
    status,
    accountId: accountId || undefined,
  };
};

const handleChannelsDisconnect: MutationHandler = async (_userId, body) => {
  const channel = parseString(body.channel, 'channel');
  if (!channel || !isPairChannelType(channel)) {
    throw new NodesActionError('Unsupported channel for unpair.');
  }
  const accountId = parseString(body.accountId, 'accountId', { required: false });
  await unpairChannel(channel, accountId || undefined);
  return {
    action: 'channels.disconnect',
    channel,
    accountId: accountId || 'default',
  };
};

const handleChannelsRotateSecret: MutationHandler = async (_userId, body) => {
  const channel = parseString(body.channel, 'channel');
  if (channel !== 'whatsapp' && channel !== 'imessage') {
    throw new NodesActionError('Secret rotation is only supported for bridge channels.');
  }
  const accountId = normalizeBridgeAccountId(
    parseString(body.accountId, 'accountId', { required: false }),
  );
  const newSecret = randomBytes(24).toString('base64url');

  upsertBridgeAccount(channel, {
    accountId,
    webhookSecret: newSecret,
    pairingStatus: 'connected',
    touchLastSeen: true,
  });

  return {
    action: 'channels.rotateSecret',
    channel,
    accountId,
    rotatedAt: new Date().toISOString(),
  };
};

const handleTelegramRejectPending: MutationHandler = async () => {
  return {
    action: 'telegram.rejectPending',
    rejected: rejectTelegramPendingPairingRequest(),
  };
};

const mutationHandlers: Record<string, MutationHandler> = {
  'bindings.setPersona': handleBindingsSetPersona,
  'channels.connect': handleChannelsConnect,
  'channels.disconnect': handleChannelsDisconnect,
  'channels.rotateSecret': handleChannelsRotateSecret,
  'exec.approve': handleExecApprove,
  'exec.clear': handleExecClear,
  'exec.revoke': handleExecRevoke,
  'telegram.rejectPending': handleTelegramRejectPending,
};

async function applyMutation(
  userId: string,
  body: NodesMutationRequest,
): Promise<OpsNodesResponse['mutation']> {
  const action = parseString(body.action, 'action');
  if (!action) {
    throw new NodesActionError('action is required.');
  }

  const handler = mutationHandlers[action];
  if (!handler) {
    throw new NodesActionError('Unsupported action.');
  }
  return handler(userId, body);
}

export const GET = withUserContext(async ({ request, userContext }) => {
  const payload = await buildNodesPayload(userContext.userId, {
    memoryDiagnosticsEnabled: parseMemoryDiagnosticsEnabled(request),
    channelLimit: parseChannelLimit(request),
  });

  return NextResponse.json(payload);
});

export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const body = (await request.json()) as NodesMutationRequest;
    const mutation = await applyMutation(userContext.userId, body);
    const payload = await buildNodesPayload(userContext.userId, {
      memoryDiagnosticsEnabled: false,
      channelLimit: DEFAULT_CHANNEL_LIMIT,
      mutation,
    });
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof NodesActionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to apply nodes action.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
