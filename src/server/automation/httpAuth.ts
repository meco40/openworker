import { resolveRequestUserContext } from '../auth/userContext';
import { getPrincipalUserId } from '../auth/principal';

export async function resolveAutomationUserId(): Promise<string | null> {
  const context = await resolveRequestUserContext();
  if (context?.userId) {
    return context.userId;
  }

  const requireAuth = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
  if (requireAuth) {
    return null;
  }

  return getPrincipalUserId();
}
