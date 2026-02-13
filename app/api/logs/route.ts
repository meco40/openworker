import { resolveRequestUserContext } from '../../../src/server/auth/userContext';
import { getLogRepository } from '../../../src/logging/logRepository';
import type { LogCategory, LogLevel } from '../../../src/logging/logTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const limit = searchParams.get('limit');
  const before = searchParams.get('before');

  const logs = repo.listLogs({
    level: level || undefined,
    source: source || undefined,
    category: category || undefined,
    search: search || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    before: before || undefined,
  });

  const count = repo.getLogCount({
    level: level || undefined,
    source: source || undefined,
    category: category || undefined,
    search: search || undefined,
    before: before || undefined,
  });

  return Response.json({ ok: true, logs, total: count });
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
