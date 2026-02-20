import { NextResponse } from 'next/server';
import { processTelegramInboundUpdate } from '../../../../../src/server/channels/pairing/telegramInbound';
import { verifyTelegramWebhook } from '../../../../../src/server/channels/webhookAuth';

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
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    audio?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
      title?: string;
      performer?: string;
    };
    voice?: {
      file_id: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
    };
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

export async function POST(request: Request) {
  try {
    const { getCredentialStore } = await import('../../../../../src/server/channels/credentials');
    const secretToken =
      getCredentialStore().getCredential('telegram', 'webhook_secret') ||
      process.env.TELEGRAM_WEBHOOK_SECRET ||
      '';
    if (!verifyTelegramWebhook(request, secretToken)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const update = (await request.json()) as TelegramUpdate;

    if (!update.message && !update.callback_query) {
      return NextResponse.json({ ok: true });
    }

    await processTelegramInboundUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Always return 200 to Telegram to prevent retries.
    return NextResponse.json({ ok: true });
  }
}
