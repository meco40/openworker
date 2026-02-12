/**
 * GET  /api/skills       → List all skills
 * POST /api/skills       → Install a new skill
 */

import { NextResponse } from 'next/server';
import { getSkillRepository } from '../../../src/server/skills/skillRepository';
import { installFromSource } from '../../../src/server/skills/skillInstaller';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const repo = await getSkillRepository();
    const skills = repo.listSkills();
    return NextResponse.json({ ok: true, skills });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list skills';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface InstallRequest {
  source: 'github' | 'npm' | 'manual';
  value: string | Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as InstallRequest;
    const skill = await installFromSource(body.source, body.value);
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Skill installation failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
