import { NextResponse } from 'next/server';

import type { OpsAgentsResponse } from '@/modules/ops/types';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

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

export const GET = withUserContext(async ({ request, userContext }) => {
  const limit = parseLimit(request);
  const userId = userContext.userId;
  const personas = getPersonaRepository()
    .listPersonas(userId)
    .map((persona) => ({
      id: persona.id,
      name: persona.name,
      emoji: persona.emoji,
      vibe: persona.vibe,
      updatedAt: persona.updatedAt,
    }));

  const payload: OpsAgentsResponse = {
    ok: true,
    query: { limit },
    agents: {
      personas,
      generatedAt: new Date().toISOString(),
    },
  };

  return NextResponse.json(payload);
});
