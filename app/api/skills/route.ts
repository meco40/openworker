/**
 * GET  /api/skills       → List all skills
 * POST /api/skills       → Install a new skill
 */

import { NextResponse } from 'next/server';
import { getSkillRepository } from '@/server/skills/skillRepository';
import { installFromSource } from '@/server/skills/skillInstaller';

export const runtime = 'nodejs';

export async function GET() {
  try {
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
    const body = (await request.json()) as InstallRequest;
    const skill = await installFromSource(body.source, body.value);
    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Skill installation failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
