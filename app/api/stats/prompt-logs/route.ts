import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getTokenUsageRepository } from '../../../../src/server/stats/tokenUsageRepository';
import {
  getPromptDispatchRepository,
  type PromptDispatchFilter,
} from '../../../../src/server/stats/promptDispatchRepository';
import {
  getPromptDispatchDiagnostics,
  resetPromptDispatchDiagnostics,
} from '../../../../src/server/stats/promptDispatchDiagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolvePreset(preset: string): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();

  switch (preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case 'week': {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: start.toISOString(), to };
    }
    default:
      return {};
  }
}

export async function GET(request: Request) {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const repo = getPromptDispatchRepository();

    let from = searchParams.get('from') || undefined;
    let to = searchParams.get('to') || undefined;
    const preset = searchParams.get('preset');
    if (preset && !from) {
      const resolved = resolvePreset(preset);
      from = resolved.from;
      to = resolved.to;
    }

    const limitParam = Number.parseInt(searchParams.get('limit') || '100', 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 100;

    const filter: PromptDispatchFilter = {
      from,
      to,
      search: searchParams.get('search') || undefined,
      provider: searchParams.get('provider') || undefined,
      model: searchParams.get('model') || undefined,
      risk: (searchParams.get('risk') as PromptDispatchFilter['risk']) || undefined,
      before: searchParams.get('before') || undefined,
      limit,
    };

    const entries = repo.listDispatches(filter);
    const total = repo.countDispatches(filter);
    const summary = repo.getSummary(filter);
    const diagnostics = getPromptDispatchDiagnostics();
    const latestEntry = repo.listDispatches({ limit: 1 })[0];
    const diagnosticsWithFallback = {
      ...diagnostics,
      attemptsSinceBoot:
        diagnostics.attemptsSinceBoot > 0 ? diagnostics.attemptsSinceBoot : summary.totalEntries,
      writesSinceBoot:
        diagnostics.writesSinceBoot > 0 ? diagnostics.writesSinceBoot : summary.totalEntries,
      lastInsertAt: diagnostics.lastInsertAt || latestEntry?.createdAt || null,
    };

    return Response.json({
      ok: true,
      entries,
      total,
      summary,
      diagnostics: diagnosticsWithFallback,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch prompt logs.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const repo = getPromptDispatchRepository();
    const tokenUsageRepo = getTokenUsageRepository();
    const deletedPromptLogs = repo.clearDispatches();
    const deletedTokenUsage = tokenUsageRepo.clearEntries();
    resetPromptDispatchDiagnostics();
    return Response.json({ ok: true, deletedPromptLogs, deletedTokenUsage });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear prompt logs.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
