import type { Session } from 'next-auth';
import { auth } from '../../auth';
import { LEGACY_LOCAL_USER_ID } from './constants';

export { LEGACY_LOCAL_USER_ID } from './constants';

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

  return LEGACY_LOCAL_USER_ID;
}

export async function resolveRequestUserContext(): Promise<
  | {
      userId: string;
      authenticated: boolean;
    }
  | null
> {
  const session = await auth();
  const userId = resolveUserIdFromSession(session, isAuthRequired());

  if (!userId) {
    return null;
  }

  return {
    userId,
    authenticated: Boolean(session?.user && 'id' in session.user && session.user.id),
  };
}
