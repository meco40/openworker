import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../src/server/auth/userContext';
import { getPersonaRepository } from '../../../../../../src/server/personas/personaRepository';
import { PERSONA_FILE_NAMES, type PersonaFileName } from '../../../../../../src/server/personas/personaTypes';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string; filename: string }> };

// ─── GET /api/personas/[id]/files/[filename] ─── Read a persona file
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id, filename } = await params;

    if (!PERSONA_FILE_NAMES.includes(filename as PersonaFileName)) {
      return NextResponse.json(
        { ok: false, error: `Invalid filename. Allowed: ${PERSONA_FILE_NAMES.join(', ')}` },
        { status: 400 },
      );
    }

    const repo = getPersonaRepository();

    // Verify ownership
    const persona = repo.getPersona(id);
    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const content = repo.getFile(id, filename as PersonaFileName);
    return NextResponse.json({ ok: true, filename, content: content ?? '' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── PUT /api/personas/[id]/files/[filename] ─── Write a persona file
// Body: { content: string }
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id, filename } = await params;

    if (!PERSONA_FILE_NAMES.includes(filename as PersonaFileName)) {
      return NextResponse.json(
        { ok: false, error: `Invalid filename. Allowed: ${PERSONA_FILE_NAMES.join(', ')}` },
        { status: 400 },
      );
    }

    const repo = getPersonaRepository();

    // Verify ownership
    const persona = repo.getPersona(id);
    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json()) as { content?: string };
    if (typeof body.content !== 'string') {
      return NextResponse.json({ ok: false, error: 'content (string) is required' }, { status: 400 });
    }

    repo.saveFile(id, filename as PersonaFileName, body.content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
