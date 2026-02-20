import { getTokenUsageRepository } from '@/server/stats/tokenUsageRepository';
import { getMessageRepository } from '@/server/channels/messages/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionLensSummary {
  totalSessions: number;
  byChannel: Array<{ channelType: string; count: number }>;
  topSessions: Array<{
    id: string;
    title: string;
    channelType: string;
    externalChatId: string | null;
    modelOverride: string | null;
    personaId: string | null;
    updatedAt: string;
  }>;
}

function resolvePreset(preset: string): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();

  switch (preset) {
    case 'today': {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      return { from: startOfDay.toISOString(), to };
    }
    case 'week': {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      return { from: startOfWeek.toISOString(), to };
    }
    case 'month': {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfMonth.toISOString(), to };
    }
    default:
      return { from: '', to };
  }
}

function parseIncludeSessions(searchParams: URLSearchParams): boolean {
  const raw = String(searchParams.get('sessions') || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function buildSessionLens(): SessionLensSummary {
  const repo = getMessageRepository();
  const sessions = repo.listConversations(200);

  const countsByChannel = new Map<string, number>();
  for (const session of sessions) {
    const channelKey = String(session.channelType || 'unknown');
    countsByChannel.set(channelKey, (countsByChannel.get(channelKey) || 0) + 1);
  }

  const byChannel = Array.from(countsByChannel.entries())
    .map(([channelType, count]) => ({ channelType, count }))
    .sort((left, right) => right.count - left.count);

  return {
    totalSessions: sessions.length,
    byChannel,
    topSessions: sessions.slice(0, 20).map((session) => ({
      id: session.id,
      title: session.title,
      channelType: String(session.channelType),
      externalChatId: session.externalChatId,
      modelOverride: session.modelOverride,
      personaId: session.personaId,
      updatedAt: session.updatedAt,
    })),
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const repo = getTokenUsageRepository();

    let from = searchParams.get('from') || undefined;
    let to = searchParams.get('to') || undefined;

    const preset = searchParams.get('preset');
    if (preset && !from) {
      const resolved = resolvePreset(preset);
      from = resolved.from || undefined;
      to = resolved.to || undefined;
    }

    const includeSessions = parseIncludeSessions(searchParams);

    const total = repo.getTotalTokens(from, to);
    const byModel = repo.getUsageSummary(from, to);
    const entryCount = repo.getEntryCount();
    const uptimeSeconds = Math.floor(process.uptime());

    return Response.json({
      ok: true,
      overview: {
        uptimeSeconds,
        totalRequests: entryCount,
      },
      tokenUsage: {
        total: {
          prompt: total.promptTokens,
          completion: total.completionTokens,
          total: total.totalTokens,
        },
        byModel: byModel.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          prompt: entry.promptTokens,
          completion: entry.completionTokens,
          total: entry.totalTokens,
        })),
      },
      sessionLens: includeSessions ? buildSessionLens() : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch stats.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
