import { NextResponse } from 'next/server';

import type { OpsSessionSummary, OpsSessionsResponse } from '@/modules/ops/types';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getMessageService } from '@/server/channels/messages/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const MIN_ACTIVE_MINUTES = 1;
const MAX_ACTIVE_MINUTES = 10_080;

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

function parseQuery(request: Request): string {
  return String(new URL(request.url).searchParams.get('q') || '').trim();
}

function parseBooleanFlag(
  searchParams: URLSearchParams,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = searchParams.get(key);
  if (raw === null) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseActiveMinutes(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('activeMinutes');
  if (raw === null || raw.trim() === '') {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, MIN_ACTIVE_MINUTES), MAX_ACTIVE_MINUTES);
}

function toUpdatedTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isUnknownSession(session: OpsSessionSummary): boolean {
  return !String(session.personaId || '').trim();
}

function includesSearchHit(session: OpsSessionSummary, query: string): boolean {
  if (!query) return true;
  const normalizedQuery = query.toLowerCase();
  return [session.id, session.title, session.channelType, session.externalChatId, session.personaId]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(normalizedQuery));
}

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limit = parseLimit(request);
  const query = parseQuery(request);
  const activeMinutes = parseActiveMinutes(request);
  const searchParams = new URL(request.url).searchParams;
  const includeGlobalRequested = parseBooleanFlag(searchParams, 'includeGlobal', false);
  const includeUnknown = parseBooleanFlag(searchParams, 'includeUnknown', true);
  const includeGlobalApplied = includeGlobalRequested && !userContext.authenticated;

  const messageService = getMessageService();
  const ownSessions = messageService.listConversations(userContext.userId, limit);
  const candidateSessions = includeGlobalApplied
    ? (() => {
        const merged = new Map<string, OpsSessionSummary>();
        for (const session of ownSessions) {
          merged.set(session.id, session);
        }
        for (const session of messageService.listConversations(undefined, limit)) {
          if (!merged.has(session.id)) {
            merged.set(session.id, session);
          }
        }
        return Array.from(merged.values());
      })()
    : ownSessions;

  const minUpdatedAt = activeMinutes === null ? null : Date.now() - activeMinutes * 60 * 1000;
  const sessions = candidateSessions
    .filter((session) => {
      if (!includesSearchHit(session, query)) {
        return false;
      }
      if (!includeUnknown && isUnknownSession(session)) {
        return false;
      }
      if (minUpdatedAt === null) {
        return true;
      }
      const updatedAtMs = toUpdatedTimestamp(session.updatedAt);
      return updatedAtMs === null ? true : updatedAtMs >= minUpdatedAt;
    })
    .sort((left, right) => {
      const leftMs = toUpdatedTimestamp(left.updatedAt) ?? 0;
      const rightMs = toUpdatedTimestamp(right.updatedAt) ?? 0;
      return rightMs - leftMs;
    })
    .slice(0, limit);

  const payload: OpsSessionsResponse = {
    ok: true,
    query: {
      q: query,
      limit,
      activeMinutes,
      includeGlobalRequested,
      includeGlobalApplied,
      includeUnknown,
    },
    sessions,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
