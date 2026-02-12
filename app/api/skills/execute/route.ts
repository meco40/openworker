import { NextResponse } from 'next/server';
import { dispatchSkill, normalizeSkillArgs } from '../../../../src/server/skills/executeSkill';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface SkillRequest {
  name: string;
  args?: unknown;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as SkillRequest;
    const result = await dispatchSkill(body.name, normalizeSkillArgs(body.args));
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown skill execution error';
    const status = String(message).startsWith('Unsupported skill:') ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
