import { NextResponse } from 'next/server';
import { PERSONA_TEMPLATES } from '@/lib/persona-templates';
import { withUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';

// ─── GET /api/personas/templates ─── List available starter templates
export const GET = withUserContext(async () => {
  const templates = PERSONA_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    vibe: t.vibe,
  }));

  return NextResponse.json({ ok: true, templates });
});
