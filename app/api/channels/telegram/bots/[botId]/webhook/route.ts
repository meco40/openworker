import { NextResponse } from 'next/server';
import { verifyTelegramWebhook } from '@/server/channels/webhookAuth';
import { processTelegramInboundUpdate } from '@/server/channels/pairing/telegramInbound';
import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

export const runtime = 'nodejs';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string; is_forum?: boolean };
    text?: string;
    caption?: string;
    message_thread_id?: number;
    migrate_to_chat_id?: number;
    migrate_from_chat_id?: number;
    photo?: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    audio?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
      title?: string;
      performer?: string;
    };
    voice?: { file_id: string; mime_type?: string; file_size?: number; duration?: number };
    video?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
    };
    animation?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
    };
    sticker?: {
      file_id: string;
      file_unique_id?: string;
      emoji?: string;
      set_name?: string;
      is_animated?: boolean;
      is_video?: boolean;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: number; type?: string; is_forum?: boolean };
    };
  };
}

// ─── POST /api/channels/telegram/bots/[botId]/webhook ─── Receive updates for a persona-bound bot
export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  try {
    const { botId } = await params;

    const registry = getPersonaTelegramBotRegistry();
    const bot = registry.getBot(botId);

    if (!bot || !bot.active) {
      // Respond 200 to prevent Telegram from disabling the webhook after repeated failures
      return NextResponse.json({ ok: true });
    }

    if (!verifyTelegramWebhook(request, bot.webhookSecret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const update = (await request.json()) as TelegramUpdate;

    if (!update.message && !update.callback_query) {
      return NextResponse.json({ ok: true });
    }

    await processTelegramInboundUpdate(update, {
      botId,
      personaId: bot.personaId,
      token: bot.token,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Persona-bot webhook error:', error);
    // Always return 200 to Telegram to prevent retries.
    return NextResponse.json({ ok: true });
  }
}
