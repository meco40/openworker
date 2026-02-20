import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getLogRepository } from '@/logging/logRepository';
import type { LogCategory, LogLevel } from '@/logging/logTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

/**
 * GET /api/logs — fetch historical logs with optional filters.
 *
 * Query params:
 *   level   – 'debug' | 'info' | 'warn' | 'error'
 *   source  – e.g. 'SYS', 'AUTH', 'TOOL'
 *   search  – full-text search on message
 *   limit   – max entries (default 200)
 *   before  – ISO timestamp for cursor-based pagination
 *   sources – if set, returns distinct source list instead
 */
export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const repo = getLogRepository();

  // Special: return available sources
  if (searchParams.has('sources')) {
    return Response.json({ ok: true, sources: repo.getSources() });
  }
  if (searchParams.has('categories')) {
    return Response.json({ ok: true, categories: repo.getCategories() });
  }

  const level = searchParams.get('level') as LogLevel | null;
  const source = searchParams.get('source');
  const category = searchParams.get('category') as LogCategory | null;
  const search = searchParams.get('search');
  const limit = parseLimit(searchParams);
  const before = searchParams.get('before');

  const logs = repo.listLogs({
    level: level || undefined,
    source: source || undefined,
    category: category || undefined,
    search: search || undefined,
    limit,
    before: before || undefined,
  });

  const total = repo.getLogCount({
    level: level || undefined,
    source: source || undefined,
    category: category || undefined,
    search: search || undefined,
  });

  const pageWindowCount = repo.getLogCount({
    level: level || undefined,
    source: source || undefined,
    category: category || undefined,
    search: search || undefined,
    before: before || undefined,
  });
  const hasMore = pageWindowCount > logs.length;
  const nextCursor = logs.length > 0 ? (logs[0]?.createdAt ?? null) : null;
  return Response.json({
    ok: true,
    logs,
    total,
    page: {
      limit,
      before: before || null,
      returned: logs.length,
      hasMore,
      nextCursor,
    },
  });
}

/**
 * DELETE /api/logs — clear all logs.
 */
export async function DELETE() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const repo = getLogRepository();
  const deleted = repo.clearLogs();
  return Response.json({ ok: true, deleted });
}
