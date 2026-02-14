import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getMemoryService } from '../../../../src/server/memory/runtime';
import { getModelHubService } from '../../../../src/server/model-hub/runtime';
import { getPersonaRepository } from '../../../../src/server/personas/personaRepository';

export const runtime = 'nodejs';

function isPreferredModelAvailable(preferredModelId: string): boolean {
  const modelHub = getModelHubService();
  const activePipeline = modelHub.listPipeline('p1');
  return activePipeline.some(
    (entry) => entry.status === 'active' && entry.modelName === preferredModelId,
  );
}

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
      preferredModelId?: string | null;
    };

    const updates: {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
    } = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.emoji !== undefined) updates.emoji = body.emoji.trim();
    if (body.vibe !== undefined) updates.vibe = body.vibe.trim();
    if (body.preferredModelId !== undefined) {
      if (body.preferredModelId === null) {
        updates.preferredModelId = null;
      } else if (typeof body.preferredModelId === 'string' && body.preferredModelId.trim().length) {
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

    getMemoryService().deleteByPersona(id);
    repo.deletePersona(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
