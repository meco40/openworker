import { NextResponse } from 'next/server';

import type { OpsAgentsResponse } from '@/modules/ops/types';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { parseClampedInt } from '../_shared/query';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export const GET = withUserContext(async ({ request, userContext }) => {
  const limit = parseClampedInt(request, 'limit', DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
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
