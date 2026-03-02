/**
 * PATCH  /api/skills/:id  → Toggle installed status
 * DELETE /api/skills/:id  → Remove skill entirely
 */

import { NextResponse } from 'next/server';
import { getSkillRepository } from '@/server/skills/skillRepository';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

interface PatchBody {
  installed: boolean;
}

interface SkillIdParams {
  id: string;
}

export const PATCH = withUserContext<SkillIdParams>(async ({ request, params }) => {
  try {
    const [body, repo] = await Promise.all([
      request.json() as Promise<PatchBody>,
      getSkillRepository(),
    ]);
    const { id } = params;
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
});

export const DELETE = withUserContext<SkillIdParams>(async ({ params }) => {
  try {
    const repo = await getSkillRepository();
    const { id } = params;
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
});
