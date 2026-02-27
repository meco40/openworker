import { resolveRequestUserContext } from '@/server/auth/userContext';
import {
  resolveMasterWorkspaceScope,
  type MasterWorkspaceBinding,
} from '@/server/master/workspaceScope';

interface ScopeBody {
  personaId?: string | null;
  workspaceId?: string | null;
  workspaceCwd?: string | null;
}

export async function resolveMasterUserId(): Promise<string | null> {
  const context = await resolveRequestUserContext();
  return context?.userId || null;
}

export function resolveScopeFromRequest(
  request: Request,
  userId: string,
  body?: ScopeBody,
): MasterWorkspaceBinding {
  const url = new URL(request.url);
  const personaId = body?.personaId ?? url.searchParams.get('personaId');
  const workspaceId = body?.workspaceId ?? url.searchParams.get('workspaceId');
  const workspaceCwd = body?.workspaceCwd ?? url.searchParams.get('workspaceCwd');
  return resolveMasterWorkspaceScope({
    userId,
    personaId,
    workspaceId,
    workspaceCwd,
  });
}
