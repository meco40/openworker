import { NextResponse } from 'next/server';

import type { OpsSessionSummary, OpsSessionsResponse } from '@/modules/ops/types';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getMessageService } from '@/server/channels/messages/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

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
  const sessions = getMessageService()
    .listConversations(userContext.userId, limit)
    .filter((session) => includesSearchHit(session, query));

  const payload: OpsSessionsResponse = {
    ok: true,
    query: {
      q: query,
      limit,
    },
    sessions,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
