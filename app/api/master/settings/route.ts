import { NextResponse } from 'next/server';
import { isMasterSystemPersonaEnabled } from '@/server/master/featureFlags';
import { getModelHubService } from '@/server/model-hub/runtime';
import { ensureMasterPersona } from '@/server/master/systemPersona';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { PERSONA_INSTRUCTION_FILES, type PersonaFileName } from '@/server/personas/personaTypes';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MasterSettingsBody {
  preferredModelId?: string | null;
  modelHubProfileId?: string | null;
  isAutonomous?: boolean;
  maxToolCalls?: number;
  allowedToolFunctionNames?: string[];
  files?: Partial<Record<PersonaFileName, string>>;
}

function isPreferredModelAvailable(preferredModelId: string): boolean {
  const modelHub = getModelHubService();
  const activePipeline = modelHub.listPipeline('p1');
  return activePipeline.some(
    (entry) => entry.status === 'active' && entry.modelName === preferredModelId,
  );
}

function isValidModelHubProfileId(value: string): boolean {
  if (!value.trim()) return false;
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value.trim());
}

function buildSettingsPayload(personaId: string) {
  const persona = getPersonaRepository().getPersonaWithFiles(personaId);
  if (!persona) {
    throw new Error('Master persona could not be loaded.');
  }

  const instructionFiles = Object.fromEntries(
    PERSONA_INSTRUCTION_FILES.map((filename) => [filename, persona.files[filename] ?? '']),
  ) as Record<PersonaFileName, string>;

  return {
    ok: true as const,
    persona: {
      id: persona.id,
      name: persona.name,
      slug: persona.slug,
      emoji: persona.emoji,
      systemPersonaKey: persona.systemPersonaKey,
    },
    runtimeSettings: {
      preferredModelId: persona.preferredModelId,
      modelHubProfileId: persona.modelHubProfileId,
      isAutonomous: persona.isAutonomous,
      maxToolCalls: persona.maxToolCalls,
    },
    allowedToolFunctionNames: persona.allowedToolFunctionNames,
    instructionFiles,
  };
}

export const GET = withUserContext(async ({ userContext }) => {
  try {
    if (!isMasterSystemPersonaEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Master system persona is disabled.' },
        { status: 404 },
      );
    }
    const master = ensureMasterPersona(userContext.userId);
    return NextResponse.json(buildSettingsPayload(master.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load Master settings';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});

export const PUT = withUserContext(async ({ request, userContext }) => {
  try {
    if (!isMasterSystemPersonaEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Master system persona is disabled.' },
        { status: 404 },
      );
    }
    const repo = getPersonaRepository();
    const master = ensureMasterPersona(userContext.userId, repo);
    const body = (await request.json()) as MasterSettingsBody;

    const updates: {
      preferredModelId?: string | null;
      modelHubProfileId?: string | null;
      isAutonomous?: boolean;
      maxToolCalls?: number;
    } = {};

    if (body.preferredModelId !== undefined) {
      if (body.preferredModelId === null) {
        updates.preferredModelId = null;
      } else if (
        typeof body.preferredModelId === 'string' &&
        body.preferredModelId.trim().length > 0
      ) {
        const normalizedModelId = body.preferredModelId.trim();
        if (!isPreferredModelAvailable(normalizedModelId)) {
          return NextResponse.json(
            { ok: false, error: `preferredModelId "${normalizedModelId}" is not available.` },
            { status: 400 },
          );
        }
        updates.preferredModelId = normalizedModelId;
      } else {
        return NextResponse.json(
          { ok: false, error: 'preferredModelId must be a non-empty string or null' },
          { status: 400 },
        );
      }
    }

    if (body.modelHubProfileId !== undefined) {
      if (body.modelHubProfileId === null) {
        updates.modelHubProfileId = null;
      } else if (
        typeof body.modelHubProfileId === 'string' &&
        isValidModelHubProfileId(body.modelHubProfileId)
      ) {
        updates.modelHubProfileId = body.modelHubProfileId.trim();
      } else {
        return NextResponse.json(
          {
            ok: false,
            error:
              'modelHubProfileId must be a non-empty string (letters, numbers, ".", "_" or "-") or null',
          },
          { status: 400 },
        );
      }
    }

    if (body.isAutonomous !== undefined) {
      updates.isAutonomous = Boolean(body.isAutonomous);
    }

    if (body.maxToolCalls !== undefined) {
      const num = Math.floor(Number(body.maxToolCalls));
      if (!Number.isFinite(num) || num < 3 || num > 500) {
        return NextResponse.json(
          { ok: false, error: 'maxToolCalls must be an integer between 3 and 500' },
          { status: 400 },
        );
      }
      updates.maxToolCalls = num;
    }

    if (Object.keys(updates).length > 0) {
      repo.updatePersona(master.id, updates);
    }

    if (Array.isArray(body.allowedToolFunctionNames)) {
      repo.setAllowedToolFunctionNames(master.id, body.allowedToolFunctionNames);
    }

    if (body.files && typeof body.files === 'object') {
      for (const filename of PERSONA_INSTRUCTION_FILES) {
        const content = body.files[filename];
        if (typeof content === 'string') {
          repo.saveFile(master.id, filename, content);
        }
      }
    }

    return NextResponse.json(buildSettingsPayload(master.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update Master settings';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
});
