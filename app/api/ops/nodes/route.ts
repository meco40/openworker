import { NextResponse } from 'next/server';

import { runDoctorCommand } from '@/commands/doctorCommand';
import { runHealthCommand } from '@/commands/healthCommand';
import type { OpsNodesResponse } from '@/modules/ops/types';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { getAutomationService } from '@/server/automation/runtime';
import { getRoomRepository } from '@/server/rooms/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_CHANNEL_LIMIT = 50;
const MIN_CHANNEL_LIMIT = 1;
const MAX_CHANNEL_LIMIT = 200;

function parseChannelLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('limit');
  if (raw === null) {
    return DEFAULT_CHANNEL_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHANNEL_LIMIT;
  }

  return Math.min(Math.max(parsed, MIN_CHANNEL_LIMIT), MAX_CHANNEL_LIMIT);
}

function parseMemoryDiagnosticsEnabled(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get('memoryDiagnostics');
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const memoryDiagnosticsEnabled = parseMemoryDiagnosticsEnabled(request);
  const channelLimit = parseChannelLimit(request);

  const [health, doctor] = await Promise.all([
    runHealthCommand({ memoryDiagnosticsEnabled }),
    runDoctorCommand({ memoryDiagnosticsEnabled }),
  ]);

  const channels = (getMessageRepository().listChannelBindings?.(userContext.userId) || [])
    .slice(0, channelLimit)
    .map((channel) => ({
      channel: channel.channel,
      status: channel.status,
      externalPeerId: channel.externalPeerId ?? null,
      peerName: channel.peerName ?? null,
      transport: channel.transport ?? null,
      lastSeenAt: channel.lastSeenAt ?? null,
    }));

  const payload: OpsNodesResponse = {
    ok: true,
    nodes: {
      health: {
        status: health.status,
        summary: health.summary,
        generatedAt: health.generatedAt,
      },
      doctor: {
        status: doctor.status,
        findings: doctor.findings.length,
        recommendations: doctor.recommendations.length,
        generatedAt: doctor.generatedAt,
      },
      channels,
      automation: getAutomationService().getMetrics(),
      rooms: getRoomRepository().getMetrics(),
      generatedAt: new Date().toISOString(),
    },
  };

  return NextResponse.json(payload);
}
