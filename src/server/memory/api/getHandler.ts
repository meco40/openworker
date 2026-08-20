import { NextResponse } from 'next/server';
import { parseBoundedIntOrFallback } from '@/server/http/params';
import type { MemoryApiUserContext } from './types';
import {
  MemoryRuntimeUnavailableError,
  ValidationError,
  dedupeById,
  getReadyMemoryService,
  parseFlag,
  parseOptionalType,
  parseOptionalWorkspaceId,
  parsePersonaId,
  rankNodeTimestamp,
  resolveMemoryReadUserScopes,
} from './shared';

export async function handleMemoryGet(request: Request, userContext: MemoryApiUserContext) {
  try {
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const workspaceId = parseOptionalWorkspaceId(url.searchParams.get('workspaceId'));
    const nodeId = String(url.searchParams.get('id') || '').trim();
    const includeHistory = parseFlag(url.searchParams.get('history'));
    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');
    const userScopes = resolveMemoryReadUserScopes(userContext.userId, personaId);
    const primaryUserScope = userScopes[0] || userContext.userId;
    const page = parseBoundedIntOrFallback(pageParam, 1, 1, 1_000_000);
    const pageSize = parseBoundedIntOrFallback(pageSizeParam, 25, 1, 200);
    let service;
    try {
      service = getReadyMemoryService();
    } catch (error) {
      if (error instanceof MemoryRuntimeUnavailableError) {
        if (includeHistory) {
          return NextResponse.json({ ok: true, node: null, history: [], degraded: true });
        }
        if (pageParam !== null || pageSizeParam !== null) {
          return NextResponse.json({
            ok: true,
            nodes: [],
            pagination: { page, pageSize, total: 0, totalPages: 1 },
            degraded: true,
          });
        }
        return NextResponse.json({ ok: true, nodes: [], degraded: true });
      }
      throw error;
    }

    if (includeHistory) {
      if (!nodeId) {
        throw new ValidationError('id is required when history is requested.');
      }
      const result = await service.history(personaId, nodeId, primaryUserScope, workspaceId);
      if (!result) {
        return NextResponse.json({ ok: false, error: 'Memory node not found.' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, node: result.node, history: result.entries });
    }

    if (pageParam !== null || pageSizeParam !== null) {
      const query = String(url.searchParams.get('query') || '').trim();
      const type = parseOptionalType(url.searchParams.get('type'));
      const input = { page, pageSize, query: query || undefined, type };
      const result =
        userScopes.length > 1
          ? await service.listPageAcrossScopes(personaId, userScopes, input, workspaceId)
          : await service.listPage(personaId, input, primaryUserScope, workspaceId);
      return NextResponse.json({ ok: true, nodes: result.nodes, pagination: result.pagination });
    }

    if (userScopes.length > 1) {
      const snapshots = await Promise.all(
        userScopes.map((scopeUserId) =>
          service.snapshotWithMeta(personaId, scopeUserId, workspaceId),
        ),
      );
      const merged = dedupeById(snapshots.flatMap((snapshot) => snapshot.nodes)).sort(
        (a, b) => rankNodeTimestamp(b) - rankNodeTimestamp(a),
      );
      return NextResponse.json({
        ok: true,
        nodes: merged,
        truncated: snapshots.some((snapshot) => snapshot.truncated),
      });
    }

    const snapshot = await service.snapshotWithMeta(personaId, primaryUserScope, workspaceId);
    return NextResponse.json({
      ok: true,
      nodes: snapshot.nodes,
      truncated: snapshot.truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory snapshot.';
    const status =
      error instanceof ValidationError
        ? 400
        : error instanceof MemoryRuntimeUnavailableError
          ? 503
          : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
