import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';

type UserContext = NonNullable<Awaited<ReturnType<typeof resolveRequestUserContext>>>;

interface RouteContext<TParams> {
  params?: Promise<TParams> | TParams;
}

interface WithUserContextArgs<TParams> {
  request: Request;
  userContext: UserContext;
  params: TParams;
}

export function withUserContext<TParams = Record<string, never>>(
  handler: (args: WithUserContextArgs<TParams>) => Promise<Response>,
) {
  return async (request?: Request, context?: RouteContext<TParams>): Promise<Response> => {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const params = context?.params ? await context.params : ({} as TParams);
    return handler({
      request: request ?? new Request('http://localhost/api/_shared/with-user-context'),
      userContext,
      params,
    });
  };
}
