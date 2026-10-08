import { NextResponse } from 'next/server';
import { parseBoundedIntOrFallback } from '@/server/http/params';
import type { MemoryApiUserContext } from './types';
import {
  MemoryRuntimeUnavailableError,
  ValidationError,
  getReadyMemoryService,
  parseFlag,
  parseOptionalType,
  parseOptionalWorkspaceId,
  parsePersonaId,
  resolveMemoryReadUserScopes,
} from './shared';

export async function handleMemoryGet(request: Request, userContext: MemoryApiUserContext) {
  try {
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const workspaceId = parseOptionalWorkspaceId(url.searchParams.get('workspaceId'));
    const nodeId = String(url.searchParams.get('id') || '').trim();
    const includeHistory = parseFlag(url.searchParams.get('history'));
    const preview = parseFlag(url.searchParams.get('preview'));
    const previewLimit = parseBoundedIntOrFallback(url.searchParams.get('limit'), 50, 1, 200);
    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');
    const userScopes = resolveMemoryReadUserScopes(userContext.userId, personaId);
    const primaryUserScope = userScopes[0] || userContext.userId;
    const page = parseBoundedIntOrFallback(pageParam, 1, 1, 1_000_000);
    const pageSize = parseBoundedIntOrFallback(pageSizeParam, 25, 1, 200);
    if ((page - 1) * pageSize + pageSize > 10_000) {
      throw new ValidationError(
        'Memory pagination is limited to the first 10,000 results. Narrow the query or filters.',
      );
    }
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

    if (preview) {
      const result = await service.listPreviewAcrossScopes(
        personaId,
        userScopes.length > 0 ? userScopes : [primaryUserScope],
        previewLimit,
        workspaceId,
      );
      return NextResponse.json({ ok: true, nodes: result.nodes, truncated: result.truncated });
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

    // Backward-compatible unpaged reads are bounded as well. New UI callers
    // should always use explicit page/pageSize or preview mode.
    const snapshot = await service.listPreviewAcrossScopes(
      personaId,
      userScopes.length > 0 ? userScopes : [primaryUserScope],
      200,
      workspaceId,
    );
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
