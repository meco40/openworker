import { getTokenUsageRepository } from '../../../src/server/stats/tokenUsageRepository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves a preset name to { from, to } ISO date strings.
 */
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

/**
 * GET /api/stats — returns token usage statistics with optional time filtering.
 *
 * Query params:
 *   preset — 'today' | 'week' | 'month'
 *   from   — ISO date string (start of range)
 *   to     — ISO date string (end of range)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const repo = getTokenUsageRepository();

    // Resolve time range
    let from = searchParams.get('from') || undefined;
    let to = searchParams.get('to') || undefined;

    const preset = searchParams.get('preset');
    if (preset && !from) {
      const resolved = resolvePreset(preset);
      from = resolved.from || undefined;
      to = resolved.to || undefined;
    }

    // Gather data
    const total = repo.getTotalTokens(from, to);
    const byModel = repo.getUsageSummary(from, to);
    const entryCount = repo.getEntryCount();

    // Uptime (process-level)
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch stats.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
