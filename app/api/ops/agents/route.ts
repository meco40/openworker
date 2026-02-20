import { NextResponse } from 'next/server';

import type { OpsAgentsResponse } from '@/modules/ops/types';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { getRoomRepository, getRoomService } from '@/server/rooms/runtime';

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

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limit = parseLimit(request);
  const userId = userContext.userId;
  const roomRepository = getRoomRepository();
  const activeRoomCounts = getRoomService().listActiveRoomCountsByPersona(userId);
  const personas = getPersonaRepository()
    .listPersonas(userId)
    .map((persona) => ({
      id: persona.id,
      name: persona.name,
      emoji: persona.emoji,
      vibe: persona.vibe,
      updatedAt: persona.updatedAt,
      activeRoomCount: activeRoomCounts[persona.id] || 0,
    }));

  const sampledRooms = roomRepository
    .listRunningRooms()
    .filter((room) => room.userId === userId)
    .slice(0, limit)
    .map((room) => {
      const memberRuntime = roomRepository.listMemberRuntime(room.id);
      const runtimeByStatus = memberRuntime.reduce<Record<string, number>>((acc, runtime) => {
        const key = runtime.status;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const activeRun = roomRepository.getActiveRoomRun(room.id);

      return {
        roomId: room.id,
        roomName: room.name,
        runState: room.runState,
        memberCount: roomRepository.listMembers(room.id).length,
        runtimeByStatus,
        activeRun: activeRun
          ? {
              runId: activeRun.id,
              runState: activeRun.runState,
              leaseOwner: activeRun.leaseOwner,
              leaseExpiresAt: activeRun.leaseExpiresAt,
              heartbeatAt: activeRun.heartbeatAt,
            }
          : null,
      };
    });

  const payload: OpsAgentsResponse = {
    ok: true,
    query: { limit },
    agents: {
      personas,
      sampledRooms,
      generatedAt: new Date().toISOString(),
    },
  };

  return NextResponse.json(payload);
}
