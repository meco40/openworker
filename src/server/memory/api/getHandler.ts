import { NextResponse } from 'next/server';
import { parseBoundedIntOrFallback } from '@/server/http/params';
import { getMemoryService } from '@/server/memory/runtime';
import type { MemoryApiUserContext } from './types';
import {
  ValidationError,
  dedupeById,
  parseFlag,
  parseOptionalType,
  parsePersonaId,
  rankNodeTimestamp,
  resolveMemoryReadUserScopes,
} from './shared';

export async function handleMemoryGet(request: Request, userContext: MemoryApiUserContext) {
  try {
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const nodeId = String(url.searchParams.get('id') || '').trim();
    const includeHistory = parseFlag(url.searchParams.get('history'));
    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');
    const service = getMemoryService();
    const userScopes = resolveMemoryReadUserScopes(userContext.userId, personaId);
    const primaryUserScope = userScopes[0] || userContext.userId;

    if (includeHistory) {
      if (!nodeId) {
        throw new ValidationError('id is required when history is requested.');
      }
      const result = await service.history(personaId, nodeId, primaryUserScope);
      if (!result) {
        return NextResponse.json({ ok: false, error: 'Memory node not found.' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, node: result.node, history: result.entries });
    }

    if (pageParam !== null || pageSizeParam !== null) {
      const page = parseBoundedIntOrFallback(pageParam, 1, 1, 1_000_000);
      const pageSize = parseBoundedIntOrFallback(pageSizeParam, 25, 1, 200);
      const query = String(url.searchParams.get('query') || '').trim();
      const type = parseOptionalType(url.searchParams.get('type'));
      if (userScopes.length > 1) {
        const merged = dedupeById(
          (
            await Promise.all(
              userScopes.map((scopeUserId) => service.snapshot(personaId, scopeUserId)),
            )
          ).flat(),
        );
        const needle = query.toLowerCase();
        const filtered = merged
          .filter((node) => {
            if (!needle) return true;
            return (
              node.content.toLowerCase().includes(needle) ||
              node.type.toLowerCase().includes(needle)
            );
          })
          .filter((node) => (type ? node.type === type : true))
          .sort((a, b) => rankNodeTimestamp(b) - rankNodeTimestamp(a));
        const total = filtered.length;
        const offset = (page - 1) * pageSize;
        const nodes = filtered.slice(offset, offset + pageSize);
        return NextResponse.json({
          ok: true,
          nodes,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
          },
        });
      }
      const result = await service.listPage(
        personaId,
        {
          page,
          pageSize,
          query: query || undefined,
          type,
        },
        primaryUserScope,
      );
      return NextResponse.json({ ok: true, nodes: result.nodes, pagination: result.pagination });
    }

    if (userScopes.length > 1) {
      const merged = dedupeById(
        (
          await Promise.all(
            userScopes.map((scopeUserId) => service.snapshot(personaId, scopeUserId)),
          )
        ).flat(),
      ).sort((a, b) => rankNodeTimestamp(b) - rankNodeTimestamp(a));
      return NextResponse.json({
        ok: true,
        nodes: merged,
      });
    }

    return NextResponse.json({
      ok: true,
      nodes: await service.snapshot(personaId, primaryUserScope),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory snapshot.';
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
