import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import {
  createUnavailableError,
  isInboxV2Enabled,
  resolveDeprecationHeaders,
  resolveInboxListInput,
  toInboxV1Response,
  toInboxV2Response,
} from '@/server/channels/inbox/contract';
import { consumeInboxRateLimit } from '@/server/channels/inbox/rateLimit';
import {
  logInboxObservability,
  recordInboxQueryDuration,
  recordInboxReconnectResync,
} from '@/server/channels/inbox/observability';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

function errorResponse(
  status: number,
  code: 'INVALID_REQUEST' | 'RATE_LIMITED' | 'UNAVAILABLE',
  message: string,
): Response {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status },
  );
}

export const GET = withUserContext(async ({ request, userContext }) => {
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const input = resolveInboxListInput({
      channel: searchParams.get('channel') || '',
      q: searchParams.get('q') || '',
      limit: searchParams.get('limit') || undefined,
      cursor: searchParams.get('cursor') || undefined,
      resync: searchParams.get('resync') || undefined,
      version: searchParams.get('version') || undefined,
    });

    const v2Enabled = isInboxV2Enabled();
    if (input.version === 'v2' && !v2Enabled) {
      throw createUnavailableError('Inbox v2 is temporarily disabled.');
    }

    const rateLimit = consumeInboxRateLimit('http', userContext.userId);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many inbox requests.',
          },
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(rateLimit.retryAfterMs / 1000)),
          },
        },
      );
    }

    const service = getMessageService();
    const result = service.listInbox({
      userId: userContext.userId,
      channel: input.channel,
      query: input.query,
      limit: input.limit,
      cursor: input.cursor,
    });

    const durationMs = Date.now() - startedAt;
    recordInboxQueryDuration('http', durationMs);
    if (input.resync) {
      recordInboxReconnectResync();
    }
    logInboxObservability('query.http', {
      userId: userContext.userId,
      version: input.version,
      resync: input.resync,
      limit: input.limit,
      hasCursor: Boolean(input.cursor),
      returned: result.items.length,
      totalMatched: result.totalMatched,
      durationMs,
    });

    if (input.version === 'v1') {
      return NextResponse.json(toInboxV1Response(result), {
        headers: resolveDeprecationHeaders(),
      });
    }

    return NextResponse.json(toInboxV2Response(result));
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'INVALID_REQUEST') {
      return errorResponse(400, 'INVALID_REQUEST', error.message);
    }
    if (error instanceof Error && (error as { code?: string }).code === 'UNAVAILABLE') {
      return errorResponse(503, 'UNAVAILABLE', error.message);
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(500, 'UNAVAILABLE', message);
  }
});
