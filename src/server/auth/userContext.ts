import type { Session } from 'next-auth';
import { getPrincipalUserId } from '@/server/auth/principal';

export { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

export function isAuthRequired(): boolean {
  return String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
}

export function resolveUserIdFromSession(
  session: Pick<Session, 'user'> | null | undefined,
  requireAuth: boolean,
): string | null {
  const sessionUserId = session?.user && 'id' in session.user ? session.user.id : undefined;
  if (typeof sessionUserId === 'string' && sessionUserId.trim().length > 0) {
    return sessionUserId;
  }

  if (requireAuth) {
    return null;
  }

  return getPrincipalUserId();
}

function isMissingRequestScopeAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = String(error.message || '');
  return (
    message.includes('outside a request scope') ||
    message.includes('next-dynamic-api-wrong-context') ||
    message.includes('headers') ||
    message.includes('cookies')
  );
}

export function shouldUseLocalPrincipalWithoutSessionLookup(
  requireAuth = isAuthRequired(),
): boolean {
  if (requireAuth) {
    return false;
  }
  if (String(process.env.AUTH_OPTIONAL_SESSION_LOOKUP || 'false').toLowerCase() === 'true') {
    return false;
  }
  return process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
}

export async function resolveRequestUserContext(): Promise<{
  userId: string;
  authenticated: boolean;
} | null> {
  const requireAuth = isAuthRequired();
  if (shouldUseLocalPrincipalWithoutSessionLookup(requireAuth)) {
    return {
      userId: getPrincipalUserId(),
      authenticated: false,
    };
  }

  let session: Pick<Session, 'user'> | null | undefined;

  try {
    const { auth } = await import('@/auth');
    session = await auth();
  } catch (error) {
    if (!isMissingRequestScopeAuthError(error)) {
      throw error;
    }

    if (requireAuth) {
      return null;
    }

    return {
      userId: getPrincipalUserId(),
      authenticated: false,
    };
  }

  const userId = resolveUserIdFromSession(session, requireAuth);

  if (!userId) {
    return null;
  }

  return {
    userId,
    authenticated: Boolean(session?.user && 'id' in session.user && session.user.id),
  };
}
