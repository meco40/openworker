import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { shouldAllowApiRequestWithoutToken } from './src/server/auth/proxyPolicy';

const MC_API_TOKEN = process.env.MC_API_TOKEN;

const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();

const PUBLIC_API_PREFIXES = [
  '/api/auth',
  '/api/webhooks',
  '/api/model-hub/oauth/callback',
  '/api/channels/telegram/webhook',
  '/api/channels/telegram/bots',
  '/api/channels/discord/webhook',
  '/api/channels/slack/webhook',
  '/api/channels/whatsapp/webhook',
  '/api/channels/imessage/webhook',
  '/api/health/scheduler',
  // Graphiti authenticates this internal adapter with its own bearer token;
  // do not require a browser session or the general MC_API_TOKEN here.
  '/api/internal/model-hub/graphiti',
];

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => hasPathPrefix(pathname, prefix));
}

/**
 * Check if a request originates from the same host (browser UI).
 * Same-origin browser requests include a Referer or Origin header
 * pointing to the MC server itself. Server-side render fetches
 * (Next.js RSC) come from the same process and have no Origin.
 */
function isSameOriginRequest(request: NextRequest): boolean {
  const host = request.headers.get('host');
  if (!host) return false;

  // Server-side fetches from Next.js (no origin/referer) — same process
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // If neither origin nor referer is set, this is likely a server-side
  // fetch or a direct curl. Require auth for these (external API calls).
  if (!origin && !referer) return false;

  // Check if Origin matches the host
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === host) return true;
    } catch {
      // Invalid origin header
    }
  }

  // Check if Referer matches the host
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.host === host) return true;
    } catch {
      // Invalid referer header
    }
  }

  return false;
}

function isLoopbackHostRequest(request: NextRequest): boolean {
  const hostname = request.nextUrl.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < maxLength; i++) {
    mismatch |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return mismatch === 0;
}

// Demo mode — read-only, blocks all mutations
const DEMO_MODE = process.env.DEMO_MODE === 'true';
if (DEMO_MODE) {
  console.log('[DEMO] Running in demo mode — all write operations are blocked');
}

const CHAT_DISPLAY_SLOW_MS = Number.parseInt(process.env.CHAT_DISPLAY_SLOW_MS || '1000', 10);

function shouldLogChatDisplayProxy(): boolean {
  const chatLogs = String(process.env.CHAT_DISPLAY_LOGS || '').toLowerCase();
  const inboxLogs = String(process.env.INBOX_V2_LOGS || '').toLowerCase();
  return chatLogs === 'true' || chatLogs === '1' || inboxLogs === 'true' || inboxLogs === '1';
}

function isChatDisplayApiPath(pathname: string): boolean {
  return (
    pathname === '/api/channels/inbox' ||
    pathname === '/api/channels/messages' ||
    pathname === '/api/channels/conversations' ||
    pathname === '/api/channels/state' ||
    pathname === '/api/skills' ||
    pathname === '/api/personas' ||
    pathname.startsWith('/api/personas/')
  );
}

function logChatDisplayProxy(
  stage: string,
  payload: Record<string, unknown>,
  options: { force?: boolean } = {},
): void {
  if (!options.force && !shouldLogChatDisplayProxy()) return;
  console.info(
    JSON.stringify({
      scope: 'chat.display',
      stage,
      ts: new Date().toISOString(),
      ...payload,
    }),
  );
}

export async function proxy(request: NextRequest) {
  const startedAt = Date.now();
  const { pathname } = request.nextUrl;
  const traceChatDisplay = isChatDisplayApiPath(pathname);
  let tokenCheckMs: number | null = null;
  const finish = (
    stage: string,
    response: NextResponse,
    extra: Record<string, unknown> = {},
  ): NextResponse => {
    if (!traceChatDisplay) return response;
    const durationMs = Date.now() - startedAt;
    logChatDisplayProxy(
      `proxy.${stage}`,
      {
        path: pathname,
        method: request.method,
        durationMs,
        tokenCheckMs,
        ...extra,
      },
      { force: durationMs >= Math.max(0, CHAT_DISPLAY_SLOW_MS || 1000) },
    );
    return response;
  };

  // Only protect /api/* routes
  if (!pathname.startsWith('/api/')) {
    // Add demo mode header for UI detection
    if (DEMO_MODE) {
      const response = NextResponse.next();
      response.headers.set('X-Demo-Mode', 'true');
      return response;
    }
    return NextResponse.next();
  }

  // Public API endpoints (auth callbacks/webhooks/health probes) must stay reachable without session.
  if (isPublicApiPath(pathname)) {
    return finish('public', NextResponse.next(), { decision: 'public' });
  }

  // Demo mode: block all write operations
  if (DEMO_MODE) {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return finish(
        'demo.blocked',
        NextResponse.json(
          {
            error:
              'Demo mode — this is a read-only instance. Visit github.com/crshdn/mission-control to run your own!',
          },
          { status: 403 },
        ),
        { decision: 'blocked-demo' },
      );
    }
    return finish('demo.read', NextResponse.next(), { decision: 'allowed-demo-read' });
  }

  const sameOrigin = isSameOriginRequest(request);
  const loopbackHost = isLoopbackHostRequest(request);

  if (!REQUIRE_AUTH && sameOrigin) {
    return finish('same-origin', NextResponse.next(), {
      decision: 'same-origin',
      sameOrigin,
      loopbackHost,
      requireAuth: REQUIRE_AUTH,
      skippedSessionTokenCheck: true,
    });
  }

  if (!REQUIRE_AUTH && !MC_API_TOKEN && loopbackHost) {
    return finish('local.principal', NextResponse.next(), {
      decision: 'local-principal',
      sameOrigin,
      loopbackHost,
      requireAuth: REQUIRE_AUTH,
      skippedSessionTokenCheck: true,
    });
  }

  // Allow authenticated session requests (NextAuth cookie).
  let hasSession = false;
  try {
    const tokenStartedAt = Date.now();
    const token = await getToken({ req: request, secret: NEXTAUTH_SECRET });
    tokenCheckMs = Date.now() - tokenStartedAt;
    if (token && (typeof token.id === 'string' || typeof token.sub === 'string')) {
      hasSession = true;
    }
  } catch {
    tokenCheckMs = tokenCheckMs ?? Date.now() - startedAt;
    // Fall through to bearer validation.
  }

  if (hasSession) {
    return finish('session', NextResponse.next(), { decision: 'session' });
  }

  if (!MC_API_TOKEN) {
    if (
      shouldAllowApiRequestWithoutToken({
        requireAuth: REQUIRE_AUTH,
        hasSession,
        sameOrigin,
        loopbackHost,
      })
    ) {
      return finish('local.principal', NextResponse.next(), {
        decision: 'local-principal',
        sameOrigin,
        loopbackHost,
        requireAuth: REQUIRE_AUTH,
      });
    }
    return finish(
      'unauthorized.no-token',
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      {
        decision: 'unauthorized-no-token',
        sameOrigin,
        loopbackHost,
        requireAuth: REQUIRE_AUTH,
      },
    );
  }

  // Special case: /api/events/stream (SSE) - allow token as query param
  if (pathname === '/api/events/stream') {
    const queryToken = request.nextUrl.searchParams.get('token');
    if (queryToken && constantTimeEqual(queryToken, MC_API_TOKEN)) {
      return finish('events.query-token', NextResponse.next(), { decision: 'events-query-token' });
    }
    // Fall through to header check below
  }

  // Check Authorization header for bearer token
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return finish(
      'unauthorized.missing-bearer',
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      { decision: 'unauthorized-missing-bearer' },
    );
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!constantTimeEqual(token, MC_API_TOKEN)) {
    return finish(
      'unauthorized.bad-bearer',
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      { decision: 'unauthorized-bad-bearer' },
    );
  }

  return finish('bearer', NextResponse.next(), { decision: 'bearer' });
}

export const config = {
  matcher: ['/api/:path*'],
};
