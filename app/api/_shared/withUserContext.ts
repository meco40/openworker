import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';

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

function resolveRequestFromArgs(request?: Request): Request {
  return request ?? new Request('http://localhost/api/_shared/with-user-context');
}

export function withUserContext<TParams = Record<string, never>>(
  handler: (args: WithUserContextArgs<TParams> & { userContext: UserContext }) => Promise<Response>,
  options: WithUserContextOptions = {},
) {
  return async (request?: Request, context?: RouteContext<TParams>): Promise<Response> => {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      if (options.onUnauthorized) {
        return options.onUnauthorized();
      }
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const params = context?.params ? await context.params : ({} as TParams);
    return handler({
      request: resolveRequestFromArgs(request),
      userContext,
      params,
    });
  };
}

export function withResolvedUserContext<TParams = Record<string, never>>(
  handler: (args: WithUserContextArgs<TParams>) => Promise<Response>,
) {
  return async (request?: Request, context?: RouteContext<TParams>): Promise<Response> => {
    const userContext = await resolveRequestUserContext();
    const params = context?.params ? await context.params : ({} as TParams);
    return handler({
      request: resolveRequestFromArgs(request),
      userContext,
      params,
    });
  };
}
