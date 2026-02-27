import { getOpenClawClient } from '@/lib/openclaw/client';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.floor(num);
}

function resolveSessionId(args: Record<string, unknown>): string {
  return (
    readString(args.sessionId) ||
    readString(args.session_id) ||
    readString(args.sessionKey) ||
    readString(args.id) ||
    readString(args.to)
  );
}

function normalizeListPayload(payload: unknown): unknown[] {
  return Array.isArray(payload) ? payload : [];
}

function findSessionById(sessions: unknown[], sessionId: string): Record<string, unknown> | null {
  const normalizedTarget = sessionId.trim().toLowerCase();
  if (!normalizedTarget) return null;

  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const rawId = readString((entry as Record<string, unknown>).id);
    if (!rawId) continue;
    if (rawId.toLowerCase() === normalizedTarget) {
      return entry as Record<string, unknown>;
    }
    if (`agent:main:${rawId}`.toLowerCase() === normalizedTarget) {
      return entry as Record<string, unknown>;
    }
  }

  return null;
}

export async function agentsListHandler(_args: Record<string, unknown>) {
  const client = getOpenClawClient();
  const agents = normalizeListPayload(await client.call('agents.list', {}));
  return {
    agents,
    count: agents.length,
  };
}

export async function sessionsListHandler(args: Record<string, unknown>) {
  const client = getOpenClawClient();
  const sessions = normalizeListPayload(await client.call('sessions.list', {}));

  const limit = readNumber(args.limit);
  const limited = typeof limit === 'number' && limit > 0 ? sessions.slice(0, limit) : sessions;

  return {
    sessions: limited,
    count: limited.length,
    total: sessions.length,
  };
}

export async function sessionsHistoryHandler(args: Record<string, unknown>) {
  const sessionId = resolveSessionId(args);
  if (!sessionId) {
    throw new Error('sessions_history requires sessionId.');
  }

  const client = getOpenClawClient();
  const messages = normalizeListPayload(
    await client.call('sessions.history', { session_id: sessionId }),
  );
  return {
    sessionId,
    messages,
    count: messages.length,
  };
}

export async function sessionsSendHandler(args: Record<string, unknown>) {
  const sessionId = resolveSessionId(args);
  if (!sessionId) {
    throw new Error('sessions_send requires sessionId.');
  }

  const content =
    readString(args.content) || readString(args.message) || readString(args.text) || '';
  if (!content) {
    throw new Error('sessions_send requires content.');
  }

  const client = getOpenClawClient();
  const result = await client.call('sessions.send', {
    session_id: sessionId,
    content,
  });
  return {
    ok: true,
    sessionId,
    ...((result && typeof result === 'object' ? result : {}) as Record<string, unknown>),
  };
}

export async function sessionsSpawnHandler(args: Record<string, unknown>) {
  const client = getOpenClawClient();

  const channel = readString(args.channel) || 'mission-control';
  const peer = readString(args.peer) || readString(args.label) || undefined;
  const created = (await client.call('sessions.create', {
    channel,
    ...(peer ? { peer } : {}),
  })) as Record<string, unknown>;

  const sessionId = readString(created.id);
  const initialMessage =
    readString(args.task) || readString(args.content) || readString(args.message) || '';
  let dispatched = false;
  if (sessionId && initialMessage) {
    await client.call('sessions.send', { session_id: sessionId, content: initialMessage });
    dispatched = true;
  }

  return {
    session: created,
    dispatched,
  };
}

export async function sessionStatusHandler(args: Record<string, unknown>) {
  const client = getOpenClawClient();
  const listed = normalizeListPayload(await client.call('sessions.list', {}));
  const requestedSessionId = resolveSessionId(args);
  const fallback = listed[0];

  const selected =
    (requestedSessionId ? findSessionById(listed, requestedSessionId) : null) ??
    ((fallback && typeof fallback === 'object' ? fallback : null) as Record<
      string,
      unknown
    > | null);

  if (!selected) {
    throw new Error('No sessions found.');
  }

  const sessionId = readString(selected.id) || requestedSessionId;
  const includeHistory = Boolean(args.includeHistory);
  const history = includeHistory
    ? normalizeListPayload(await client.call('sessions.history', { session_id: sessionId }))
    : undefined;

  return {
    session: selected,
    ...(includeHistory ? { history } : {}),
  };
}
