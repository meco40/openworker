/**
 * PATCH  /api/skills/:id  → Toggle installed status
 * DELETE /api/skills/:id  → Remove skill entirely
 */

import { NextResponse } from 'next/server';
import { getSkillRepository } from '../../../../src/server/skills/skillRepository';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface PatchBody {
  installed: boolean;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = (await request.json()) as PatchBody;
    const repo = await getSkillRepository();
    const updated = repo.setInstalled(id, body.installed);

    if (!updated) {
      return NextResponse.json({ ok: false, error: `Skill "${id}" not found.` }, { status: 404 });
    }

    const skill = repo.getSkill(id);
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Update failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = await getSkillRepository();
    const skill = repo.getSkill(id);

    if (!skill) {
      return NextResponse.json({ ok: false, error: `Skill "${id}" not found.` }, { status: 404 });
    }

    if (skill.source === 'built-in') {
      return NextResponse.json(
        { ok: false, error: 'Cannot remove built-in skills. Deactivate instead.' },
        { status: 400 },
      );
    }

    repo.removeSkill(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Delete failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
