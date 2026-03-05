import { NextResponse } from 'next/server';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { PERSONA_FILE_NAMES, type PersonaFileName } from '@/server/personas/personaTypes';
import { withUserContext } from '../../../../_shared/withUserContext';

export const runtime = 'nodejs';

// ─── GET /api/personas/[id]/files/[filename] ─── Read a persona file
export const GET = withUserContext<{ id: string; filename: string }>(
  async ({ userContext, params }) => {
    try {
      const { id, filename } = params;

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
  },
);

// ─── PUT /api/personas/[id]/files/[filename] ─── Write a persona file
// Body: { content: string }
export const PUT = withUserContext<{ id: string; filename: string }>(
  async ({ request, userContext, params }) => {
    try {
      const { id, filename } = params;

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
      if (persona.systemPersonaKey) {
        return NextResponse.json(
          { ok: false, error: 'System persona files are managed by Master settings.' },
          { status: 403 },
        );
      }

      const body = (await request.json()) as { content?: string };
      if (typeof body.content !== 'string') {
        return NextResponse.json(
          { ok: false, error: 'content (string) is required' },
          { status: 400 },
        );
      }

      repo.saveFile(id, filename as PersonaFileName, body.content);
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  },
);
