import type {
  InboxCursor,
  InboxItemRecord,
  InboxListResult,
} from '@/server/channels/messages/repository';

export type InboxApiVersion = 'v1' | 'v2';

export interface InboxListInputParams {
  channel?: string;
  q?: string;
  limit?: number | string;
  cursor?: string;
  resync?: string | number | boolean;
  version?: string | number;
}

export interface ResolvedInboxListInput {
  channel: string;
  query: string;
  limit: number;
  cursor: InboxCursor | null;
  resync: boolean;
  version: InboxApiVersion;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function isInboxV2Enabled(): boolean {
  return String(process.env.INBOX_V2_ENABLED || 'true').toLowerCase() !== 'false';
}

export function resolveInboxVersion(value: string | number | undefined): InboxApiVersion {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '' || normalized === '2' || normalized === 'v2') return 'v2';
  if (normalized === '1' || normalized === 'v1') return 'v1';
  throw createInvalidRequestError('version must be 1 or 2');
}

export function resolveInboxListInput(raw: InboxListInputParams): ResolvedInboxListInput {
  const version = resolveInboxVersion(raw.version);
  const limit = resolveLimit(raw.limit);
  const channel = String(raw.channel || '').trim();
  const query = String(raw.q || '').trim();
  const cursor = parseCursor(raw.cursor);
  const resync = resolveBoolean(raw.resync);

  return {
    channel,
    query,
    limit,
    cursor,
    resync,
    version,
  };
}

export function resolveLimit(value: number | string | undefined): number {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw createInvalidRequestError('limit must be a positive integer');
  }
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

export function encodeCursor(cursor: InboxCursor | null | undefined): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function parseCursor(value: string | undefined): InboxCursor | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;

  try {
    const raw = JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      conversationId?: unknown;
    };
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : '';
    const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId.trim() : '';
    if (!updatedAt || !conversationId) {
      throw new Error('invalid');
    }
    return { updatedAt, conversationId };
  } catch {
    throw createInvalidRequestError('cursor is invalid');
  }
}

export function toInboxV2Response(result: InboxListResult): {
  ok: true;
  items: InboxItemRecord[];
  page: {
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor: string | null;
    totalMatched: number;
  };
} {
  return {
    ok: true,
    items: result.items,
    page: {
      limit: result.limit,
      returned: result.items.length,
      hasMore: result.hasMore,
      nextCursor: encodeCursor(result.nextCursor),
      totalMatched: result.totalMatched,
    },
  };
}

export function toInboxV1Response(result: InboxListResult): {
  ok: true;
  items: InboxItemRecord[];
  total: number;
  nextCursor: string | null;
} {
  return {
    ok: true,
    items: result.items,
    total: result.totalMatched,
    nextCursor: encodeCursor(result.nextCursor),
  };
}

export function createInvalidRequestError(message: string): Error & { code: 'INVALID_REQUEST' } {
  const error = new Error(message) as Error & { code: 'INVALID_REQUEST' };
  error.code = 'INVALID_REQUEST';
  return error;
}

export function createUnavailableError(message: string): Error & { code: 'UNAVAILABLE' } {
  const error = new Error(message) as Error & { code: 'UNAVAILABLE' };
  error.code = 'UNAVAILABLE';
  return error;
}

export function resolveDeprecationHeaders(): Record<string, string> {
  const sunsetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  return {
    Deprecation: 'true',
    Sunset: sunsetDate,
  };
}

function resolveBoolean(value: string | number | boolean | undefined): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}
