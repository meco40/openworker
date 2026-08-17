import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import {
  getChatDisplaySlowThresholdMs,
  isChatDisplayRequestPath,
  logChatDisplayTrace,
} from '@/server/diagnostics/chatDisplayTrace';

type ResolvedUserContext = Awaited<ReturnType<typeof resolveRequestUserContext>>;
type UserContext = NonNullable<ResolvedUserContext>;

interface RouteContext<TParams> {
  params?: Promise<TParams> | TParams;
}

interface WithUserContextArgs<TParams> {
  request: Request;
  userContext: ResolvedUserContext;
  params: TParams;
}

interface WithUserContextOptions {
  onUnauthorized?: () => Response;
}

type NextRouteContext = {
  params: Promise<Record<string, string | string[] | undefined>>;
};

type RouteHandler<TParams> = {
  (): Promise<Response>;
  (request: Request): Promise<Response>;
  (request: Request, context: RouteContext<TParams>): Promise<Response>;
  (request: Request, context: NextRouteContext): Promise<Response>;
};

function resolveRequestFromArgs(request?: Request): Request {
  return request ?? new Request('http://localhost/api/_shared/with-user-context');
}

export function withUserContext<TParams = Record<string, never>>(
  handler: (args: WithUserContextArgs<TParams> & { userContext: UserContext }) => Promise<Response>,
  options: WithUserContextOptions = {},
): RouteHandler<TParams> {
  const wrapped = async (request?: Request, context?: RouteContext<TParams>): Promise<Response> => {
    const resolvedRequest = resolveRequestFromArgs(request);
    const pathname = new URL(resolvedRequest.url).pathname;
    const shouldTrace = isChatDisplayRequestPath(pathname);
    const authStartedAt = Date.now();
    const userContext = await resolveRequestUserContext();
    const authDurationMs = Date.now() - authStartedAt;
    if (shouldTrace) {
      logChatDisplayTrace(
        'server.auth.resolved',
        {
          path: pathname,
          authenticated: Boolean(userContext?.authenticated),
          hasUserContext: Boolean(userContext),
          durationMs: authDurationMs,
        },
        { force: authDurationMs >= getChatDisplaySlowThresholdMs() },
      );
    }
    if (!userContext) {
      if (options.onUnauthorized) {
        return options.onUnauthorized();
      }
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const params = context?.params ? await context.params : ({} as TParams);
    return handler({
      request: resolvedRequest,
      userContext,
      params,
    });
  };
  return wrapped as RouteHandler<TParams>;
}

export function withResolvedUserContext<TParams = Record<string, never>>(
  handler: (args: WithUserContextArgs<TParams>) => Promise<Response>,
): RouteHandler<TParams> {
  const wrapped = async (request?: Request, context?: RouteContext<TParams>): Promise<Response> => {
    const resolvedRequest = resolveRequestFromArgs(request);
    const pathname = new URL(resolvedRequest.url).pathname;
    const shouldTrace = isChatDisplayRequestPath(pathname);
    const authStartedAt = Date.now();
    const userContext = await resolveRequestUserContext();
    const authDurationMs = Date.now() - authStartedAt;
    if (shouldTrace) {
      logChatDisplayTrace(
        'server.auth.resolved',
        {
          path: pathname,
          authenticated: Boolean(userContext?.authenticated),
          hasUserContext: Boolean(userContext),
          durationMs: authDurationMs,
        },
        { force: authDurationMs >= getChatDisplaySlowThresholdMs() },
      );
    }
    const params = context?.params ? await context.params : ({} as TParams);
    return handler({
      request: resolvedRequest,
      userContext,
      params,
    });
  };
  return wrapped as RouteHandler<TParams>;
}
