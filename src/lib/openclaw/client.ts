import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { queryAll, run } from '@/lib/db';
import type { OpenClawSessionInfo } from '@/lib/types';

type OpenClawMode = 'integrated';

interface OpenClawSessionRow {
  id: string;
  openclaw_session_id: string;
  channel: string | null;
  status: string;
}

interface AgentRow {
  id: string;
  name: string;
  model: string | null;
  status: string;
}

interface StoredGatewayMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
}

interface ChatSendResult {
  userMsgId: string;
  agentMsgId: string;
  conversationId: string;
  agentContent?: string;
  agentMetadata?: Record<string, unknown>;
}

const DEFAULT_PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SAFE_PORT = Number.isFinite(DEFAULT_PORT) && DEFAULT_PORT > 0 ? DEFAULT_PORT : 3000;
const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${SAFE_PORT}/ws`;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapStoredRoleToGatewayRole(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'agent') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

function resolveSessionKeyFromSessionId(sessionId: string): string {
  const normalized = normalizeString(sessionId);
  if (normalized.startsWith('agent:main:')) {
    return normalized;
  }
  return `agent:main:${normalized}`;
}

function isMissionControlExecutionSession(sessionKey: string): boolean {
  return /^agent:main:mission-control-/i.test(normalizeString(sessionKey));
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse failures and keep metadata undefined.
  }
  return undefined;
}

async function listConversationMessagesBySessionKey(params: {
  sessionKey: string;
  userId: string;
  limit: number;
}): Promise<StoredGatewayMessage[]> {
  const [{ ChannelType }, { getMessageService }] = await Promise.all([
    import('@/shared/domain/types'),
    import('@/server/channels/messages/runtime'),
  ]);

  const service = getMessageService();
  const conversation = service.getOrCreateConversation(
    ChannelType.WEBCHAT,
    params.sessionKey,
    undefined,
    params.userId,
  );
  const messages = service.listMessages(conversation.id, params.userId, params.limit);

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
  }));
}

async function listConversationMessagesByConversationId(params: {
  conversationId: string;
  userId: string;
  limit: number;
}): Promise<StoredGatewayMessage[]> {
  const { getMessageService } = await import('@/server/channels/messages/runtime');
  const service = getMessageService();
  const messages = service.listMessages(params.conversationId, params.userId, params.limit);

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
  }));
}

async function sendMessageToSessionKey(params: {
  sessionKey: string;
  message: string;
  userId: string;
  clientMessageId?: string;
}): Promise<ChatSendResult> {
  const [{ ChannelType }, { getMessageService }] = await Promise.all([
    import('@/shared/domain/types'),
    import('@/server/channels/messages/runtime'),
  ]);

  const service = getMessageService();
  const missionControlExecutionSession = isMissionControlExecutionSession(params.sessionKey);
  const result = await service.handleInbound(
    ChannelType.WEBCHAT,
    params.sessionKey,
    params.message,
    undefined,
    undefined,
    params.userId,
    params.clientMessageId,
    undefined,
    undefined,
    {
      skipProjectGuard: true,
      executionDirective: missionControlExecutionSession
        ? [
            'MISSION CONTROL EXECUTION MODE:',
            '- Perform real task execution via tool calls. Do not output pseudo commands or plans.',
            '- Use shell_execute/file tools to create and verify real artifacts.',
            '- On Windows, use PowerShell-compatible commands.',
            '- After execution, provide concise factual results and include TASK_COMPLETE: <summary>.',
          ].join('\n')
        : undefined,
      maxToolCalls: missionControlExecutionSession ? 120 : undefined,
      requireToolCall: missionControlExecutionSession,
    },
  );

  return {
    userMsgId: result.userMsg.id,
    agentMsgId: result.agentMsg.id,
    conversationId: result.userMsg.conversationId,
    agentContent: result.agentMsg.content,
    agentMetadata: parseMetadata(result.agentMsg.metadata),
  };
}

export class OpenClawClient extends EventEmitter {
  private connected = false;
  private readonly mode: OpenClawMode = 'integrated';

  constructor(
    private readonly url: string = process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL,
  ) {
    super();
    this.on('error', () => {});
  }

  private async resolveUserId(): Promise<string> {
    const { getPrincipalUserId } = await import('@/server/auth/principal');
    return getPrincipalUserId();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.emit('connected');
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.connect();
    const userId = await this.resolveUserId();

    switch (method) {
      case 'chat.send': {
        const sessionKey = normalizeString(params?.sessionKey);
        const message = normalizeString(params?.message);
        const conversationId = normalizeString(params?.conversationId);
        const content = normalizeString(params?.content);
        const idempotencyKey = normalizeString(params?.idempotencyKey) || undefined;

        if (sessionKey && message) {
          const response = await sendMessageToSessionKey({
            sessionKey,
            message,
            userId,
            clientMessageId: idempotencyKey,
          });
          return response as T;
        }

        if (conversationId && content) {
          const { getMessageService } = await import('@/server/channels/messages/runtime');
          const service = getMessageService();
          const response = await service.handleWebUIMessage(
            conversationId,
            content,
            userId,
            idempotencyKey,
            undefined,
            undefined,
            { skipProjectGuard: true },
          );
          return {
            userMsgId: response.userMsg.id,
            agentMsgId: response.agentMsg.id,
            conversationId,
            agentContent: response.agentMsg.content,
            agentMetadata: parseMetadata(response.agentMsg.metadata),
          } as T;
        }

        throw new Error('chat.send requires {sessionKey,message} or {conversationId,content}');
      }

      case 'chat.history': {
        const sessionKey = normalizeString(params?.sessionKey);
        const conversationId = normalizeString(params?.conversationId);
        const limitRaw = Number(params?.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;

        const messages = sessionKey
          ? await listConversationMessagesBySessionKey({ sessionKey, userId, limit })
          : conversationId
            ? await listConversationMessagesByConversationId({
                conversationId,
                userId,
                limit,
              })
            : [];

        return {
          messages: messages.map((message) => ({
            role: mapStoredRoleToGatewayRole(message.role),
            content: [{ type: 'text', text: message.content }],
            timestamp: message.timestamp,
          })),
        } as T;
      }

      case 'sessions.list': {
        return (await this.listSessions()) as T;
      }

      case 'sessions.history': {
        const sessionId = normalizeString(params?.session_id);
        return (await this.getSessionHistory(sessionId)) as T;
      }

      case 'sessions.send': {
        const sessionId = normalizeString(params?.session_id);
        const content = normalizeString(params?.content);
        await this.sendMessage(sessionId, content);
        return { ok: true } as T;
      }

      case 'sessions.create': {
        const channel = normalizeString(params?.channel);
        const peer = normalizeString(params?.peer) || undefined;
        return (await this.createSession(channel, peer)) as T;
      }

      case 'agents.list': {
        return (await this.listAgents()) as T;
      }

      case 'node.list': {
        return [] as T;
      }

      case 'node.describe': {
        return { id: normalizeString(params?.node_id), capabilities: [] } as T;
      }

      default: {
        throw new Error(`Unsupported OpenClaw method in integrated mode: ${method}`);
      }
    }
  }

  async listSessions(): Promise<OpenClawSessionInfo[]> {
    const rows = queryAll<OpenClawSessionRow>(
      `SELECT id, openclaw_session_id, channel, status
       FROM openclaw_sessions
       ORDER BY created_at DESC`,
    );

    return rows.map((row) => ({
      id: row.openclaw_session_id,
      channel: row.channel || 'mission-control',
      status: row.status || 'active',
    }));
  }

  async getSessionHistory(sessionId: string): Promise<unknown[]> {
    const sessionKey = resolveSessionKeyFromSessionId(sessionId);
    const userId = await this.resolveUserId();
    const messages = await listConversationMessagesBySessionKey({
      sessionKey,
      userId,
      limit: 100,
    });

    return messages.map((message) => ({
      role: mapStoredRoleToGatewayRole(message.role),
      content: message.content,
      timestamp: message.timestamp,
    }));
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const userId = await this.resolveUserId();
    const sessionKey = resolveSessionKeyFromSessionId(sessionId);
    await sendMessageToSessionKey({
      sessionKey,
      message: content,
      userId,
      clientMessageId: `openclaw-session-send-${randomUUID()}`,
    });
  }

  async createSession(channel: string, peer?: string): Promise<OpenClawSessionInfo> {
    const openclawSessionId =
      normalizeString(peer) || `mission-control-session-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    run(
      `INSERT INTO openclaw_sessions (id, openclaw_session_id, channel, status, session_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        openclawSessionId,
        normalizeString(channel) || 'mission-control',
        'active',
        'persistent',
        now,
        now,
      ],
    );

    return {
      id: openclawSessionId,
      channel: normalizeString(channel) || 'mission-control',
      peer,
      status: 'active',
    };
  }

  async listAgents(): Promise<unknown[]> {
    const rows = queryAll<AgentRow>(
      `SELECT id, name, model, status
       FROM agents
       WHERE source = 'gateway' OR gateway_agent_id IS NOT NULL
       ORDER BY created_at DESC`,
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      model: row.model || undefined,
      status: row.status || 'standby',
      channel: 'mission-control',
    }));
  }

  async listNodes(): Promise<unknown[]> {
    return [];
  }

  async describeNode(nodeId: string): Promise<unknown> {
    return {
      id: nodeId,
      capabilities: [],
      mode: this.mode,
    };
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  setAutoReconnect(_enabled: boolean): void {
    // No-op in integrated mode.
  }

  getGatewayUrl(): string {
    return this.url;
  }

  getMode(): OpenClawMode {
    return this.mode;
  }
}

let clientInstance: OpenClawClient | null = null;

export function getOpenClawClient(): OpenClawClient {
  if (!clientInstance) {
    clientInstance = new OpenClawClient();
  }
  return clientInstance;
}
