import { NextResponse } from 'next/server';
import { PERSONA_TEMPLATES } from '../../../../lib/persona-templates';

export const runtime = 'nodejs';

// ─── GET /api/personas/templates ─── List available starter templates
export async function GET() {
  const templates = PERSONA_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    vibe: t.vibe,
  }));

  return NextResponse.json({ ok: true, templates });
}
