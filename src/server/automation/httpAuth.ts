import { resolveRequestUserContext } from '../auth/userContext';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';
import { isPersistentSessionV2Enabled } from '../channels/messages/featureFlag';

export async function resolveAutomationUserId(): Promise<string | null> {
  if (!isPersistentSessionV2Enabled()) {
    return LEGACY_LOCAL_USER_ID;
  }

  const context = await resolveRequestUserContext();
  return context?.userId || null;
}
