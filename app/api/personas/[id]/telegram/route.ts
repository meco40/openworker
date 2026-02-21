import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import {
  pairPersonaTelegram,
  unpairPersonaTelegram,
} from '@/server/telegram/personaTelegramPairing';

export const runtime = 'nodejs';

// ─── GET /api/personas/[id]/telegram ─── Get Telegram bot status for persona
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();
    const persona = repo.getPersona(id);

    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const registry = getPersonaTelegramBotRegistry();
    const bot = registry.getBotByPersonaId(id);

    if (!bot) {
      return NextResponse.json({ ok: true, bot: null });
    }

    // Never expose the token in the response
    return NextResponse.json({
      ok: true,
      bot: {
        botId: bot.botId,
        personaId: bot.personaId,
        peerName: bot.peerName,
        transport: bot.transport,
        active: bot.active,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      },
    });
  } catch (error) {
    console.error('GET persona telegram error:', error);
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 });
  }
}

// ─── POST /api/personas/[id]/telegram ─── Pair a Telegram bot with the persona
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();
    const persona = repo.getPersona(id);

    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json()) as { token?: unknown };
    if (!body.token || typeof body.token !== 'string' || !body.token.trim()) {
      return NextResponse.json({ ok: false, error: 'token is required' }, { status: 400 });
    }

    const result = await pairPersonaTelegram(id, body.token.trim());
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('POST persona telegram error:', error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// ─── DELETE /api/personas/[id]/telegram ─── Remove Telegram bot pairing from persona
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getPersonaRepository();
    const persona = repo.getPersona(id);

    if (!persona || persona.userId !== userContext.userId) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    await unpairPersonaTelegram(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('DELETE persona telegram error:', error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
