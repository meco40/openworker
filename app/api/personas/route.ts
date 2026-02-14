import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';
import { getPersonaRepository } from '../../../src/server/personas/personaRepository';
import { getModelHubService } from '../../../src/server/model-hub/runtime';
import {
  PERSONA_FILE_NAMES,
  type CreatePersonaInput,
  type PersonaFileName,
} from '../../../src/server/personas/personaTypes';

export const runtime = 'nodejs';

function isPreferredModelAvailable(preferredModelId: string): boolean {
  const modelHub = getModelHubService();
  const activePipeline = modelHub.listPipeline('p1');
  return activePipeline.some(
    (entry) => entry.status === 'active' && entry.modelName === preferredModelId,
  );
}

// ─── GET /api/personas ─── List all personas for the current user
export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const repo = getPersonaRepository();
    const personas = repo.listPersonas(userContext.userId);
    return NextResponse.json({ ok: true, personas });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── POST /api/personas ─── Create a new persona
// Body: { name, emoji?, vibe?, files?: Record<string, string> }
export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
      files?: Record<string, string>;
    };

    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    }

    let preferredModelId: string | null = null;
    if (typeof body.preferredModelId === 'string' && body.preferredModelId.trim().length > 0) {
      preferredModelId = body.preferredModelId.trim();
      if (!isPreferredModelAvailable(preferredModelId)) {
        return NextResponse.json(
          { ok: false, error: `preferredModelId "${preferredModelId}" is not available.` },
          { status: 400 },
        );
      }
    }

    const repo = getPersonaRepository();

    // Validate and filter files (if provided) before passing to createPersona
    const validatedFiles: Partial<Record<string, string>> = {};
    if (body.files && typeof body.files === 'object') {
      for (const [filename, content] of Object.entries(body.files)) {
        if (
          typeof content === 'string' &&
          PERSONA_FILE_NAMES.includes(filename as PersonaFileName)
        ) {
          validatedFiles[filename] = content;
        }
      }
    }

    const input: CreatePersonaInput = {
      userId: userContext.userId,
      name: body.name.trim(),
      emoji: body.emoji?.trim() || '🤖',
      vibe: body.vibe?.trim() || '',
      preferredModelId,
      files:
        Object.keys(validatedFiles).length > 0
          ? (validatedFiles as Partial<Record<PersonaFileName, string>>)
          : undefined,
    };

    const persona = repo.createPersona(input);

    const full = repo.getPersonaWithFiles(persona.id);
    return NextResponse.json({ ok: true, persona: full }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
