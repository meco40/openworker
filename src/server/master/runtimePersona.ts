import { isMasterSystemPersonaEnabled } from '@/server/master/featureFlags';
import { ensureMasterPersona } from '@/server/master/systemPersona';
import { getPersonaRepository } from '@/server/personas/personaRepository';

export interface MasterRuntimePersonaConfig {
  personaId: string;
  modelHubProfileId: string;
  preferredModelId: string | null;
  systemInstruction: string | null;
  allowedToolFunctionNames: string[];
}

export function getMasterRuntimePersonaConfig(input: {
  userId: string;
  personaId?: string | null;
}): MasterRuntimePersonaConfig {
  const repo = getPersonaRepository();
  if (!isMasterSystemPersonaEnabled()) {
    const personaId = String(input.personaId || '').trim();
    if (!personaId) {
      throw new Error('personaId is required while the Master system persona rollout is disabled.');
    }
    const persona = repo.getPersona(personaId);
    if (!persona || persona.userId !== input.userId) {
      throw new Error('personaId is invalid for the current user.');
    }
    return {
      personaId: persona.id,
      modelHubProfileId: persona.modelHubProfileId || 'p1',
      preferredModelId: persona.preferredModelId,
      systemInstruction: repo.getPersonaSystemInstruction(persona.id),
      allowedToolFunctionNames: persona.allowedToolFunctionNames,
    };
  }

  const resolvedPersona =
    input.personaId && repo.getPersona(input.personaId)?.systemPersonaKey === 'master'
      ? repo.getPersona(input.personaId)
      : ensureMasterPersona(input.userId, repo);
  const persona = resolvedPersona ?? ensureMasterPersona(input.userId, repo);

  return {
    personaId: persona.id,
    modelHubProfileId: persona.modelHubProfileId || 'p1',
    preferredModelId: persona.preferredModelId,
    systemInstruction: repo.getPersonaSystemInstruction(persona.id),
    allowedToolFunctionNames: persona.allowedToolFunctionNames,
  };
}
