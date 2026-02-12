import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getPersonaRepository } from '../../../../src/server/personas/personaRepository';

export const runtime = 'nodejs';

// ─── GET /api/personas/[id] ─── Get a persona with all files
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();
    const persona = repo.getPersonaWithFiles(id);

    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, persona });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── PUT /api/personas/[id] ─── Update persona metadata
// Body: { name?, emoji?, vibe? }
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();

    // Verify ownership
    const existing = repo.getPersona(id);
    if (!existing || existing.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json()) as {
      name?: string;
      emoji?: string;
      vibe?: string;
    };

    const updates: Record<string, string> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.emoji !== undefined) updates.emoji = body.emoji.trim();
    if (body.vibe !== undefined) updates.vibe = body.vibe.trim();

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: false, error: 'No updates provided' }, { status: 400 });
    }

    repo.updatePersona(id, updates);
    const updated = repo.getPersonaWithFiles(id);
    return NextResponse.json({ ok: true, persona: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── DELETE /api/personas/[id] ─── Delete a persona
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();

    // Verify ownership
    const existing = repo.getPersona(id);
    if (!existing || existing.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    repo.deletePersona(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
