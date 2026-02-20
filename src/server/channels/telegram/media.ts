import { MAX_ATTACHMENT_BYTES, persistIncomingAttachment, type StoredMessageAttachment } from '../messages/attachments';
import { buildStickerSummary, getStickerSummary, setStickerSummary } from './stickerCache';
import { resolveTelegramVoiceLabel } from './voice';

export interface TelegramInboundMediaMessage {
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
  caption?: string;
}

type TelegramMediaCandidate = {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  summary: string;
};

export interface TelegramInboundMediaResult {
  attachments: StoredMessageAttachment[];
  summaryText: string | null;
}

export function resolveTelegramInboundText(
  message: Pick<TelegramInboundMediaMessage, 'caption'> & { text?: string },
  mediaSummary: string | null,
): string | null {
  const text = message.text?.trim();
  if (text) return text;

  const caption = message.caption?.trim();
  if (caption) return caption;

  return mediaSummary;
}

export async function extractTelegramInboundMedia(params: {
  message: TelegramInboundMediaMessage;
  userId: string;
  conversationId: string;
  botToken: string | null;
}): Promise<TelegramInboundMediaResult> {
  const candidate = resolveMediaCandidate(params.message);
  if (!candidate) {
    return { attachments: [], summaryText: null };
  }

  const summaryText = candidate.summary;
  if (!params.botToken) {
    return { attachments: [], summaryText };
  }

  try {
    const payload = await downloadTelegramFileAsDataUrl({
      token: params.botToken,
      fileId: candidate.fileId,
      fileName: candidate.fileName,
      fallbackMimeType: candidate.mimeType,
      declaredFileSize: candidate.fileSize,
    });
    if (!payload) {
      return { attachments: [], summaryText };
    }

    const stored = persistIncomingAttachment({
      userId: params.userId,
      conversationId: params.conversationId,
      attachment: payload,
    });

    return {
      attachments: [stored],
      summaryText,
    };
  } catch (error) {
    console.warn('[Telegram] Media attachment processing failed:', error);
    return { attachments: [], summaryText };
  }
}

function resolveMediaCandidate(message: TelegramInboundMediaMessage): TelegramMediaCandidate | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
    if (best?.file_id) {
      return {
        fileId: best.file_id,
        fileName: `telegram-photo-${best.file_id}.jpg`,
        mimeType: 'image/jpeg',
        fileSize: best.file_size,
        summary: '[Photo]',
      };
    }
  }

  if (message.document?.file_id) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name?.trim() || `telegram-document-${message.document.file_id}`,
      mimeType: message.document.mime_type?.trim() || 'application/octet-stream',
      fileSize: message.document.file_size,
      summary: `[Document: ${message.document.file_name?.trim() || 'file'}]`,
    };
  }

  if (message.voice?.file_id) {
    return {
      fileId: message.voice.file_id,
      fileName: `telegram-voice-${message.voice.file_id}.ogg`,
      mimeType: message.voice.mime_type?.trim() || 'audio/ogg',
      fileSize: message.voice.file_size,
      summary: resolveTelegramVoiceLabel({ voice: message.voice }) || '[Voice message]',
    };
  }

  if (message.audio?.file_id) {
    return {
      fileId: message.audio.file_id,
      fileName: message.audio.file_name?.trim() || `telegram-audio-${message.audio.file_id}.mp3`,
      mimeType: message.audio.mime_type?.trim() || 'audio/mpeg',
      fileSize: message.audio.file_size,
      summary: resolveTelegramVoiceLabel({ audio: message.audio }) || '[Audio message]',
    };
  }

  if (message.video?.file_id) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name?.trim() || `telegram-video-${message.video.file_id}.mp4`,
      mimeType: message.video.mime_type?.trim() || 'video/mp4',
      fileSize: message.video.file_size,
      summary: '[Video]',
    };
  }

  if (message.animation?.file_id) {
    return {
      fileId: message.animation.file_id,
      fileName:
        message.animation.file_name?.trim() || `telegram-animation-${message.animation.file_id}.mp4`,
      mimeType: message.animation.mime_type?.trim() || 'video/mp4',
      fileSize: message.animation.file_size,
      summary: '[Animation]',
    };
  }

  if (message.sticker?.file_id) {
    const uniqueId = message.sticker.file_unique_id?.trim();
    const cached = uniqueId ? getStickerSummary(uniqueId) : null;
    const summary =
      cached ||
      buildStickerSummary({
        emoji: message.sticker.emoji,
        setName: message.sticker.set_name,
      });
    if (uniqueId && !cached) {
      setStickerSummary(uniqueId, summary);
    }
    return {
      fileId: message.sticker.file_id,
      fileName: `telegram-sticker-${message.sticker.file_id}.webp`,
      mimeType: 'image/webp',
      summary,
    };
  }

  return null;
}

async function downloadTelegramFileAsDataUrl(params: {
  token: string;
  fileId: string;
  fileName: string;
  fallbackMimeType: string;
  declaredFileSize?: number;
}): Promise<{ name: string; type: string; size: number; dataUrl: string } | null> {
  if (typeof params.declaredFileSize === 'number' && params.declaredFileSize > MAX_ATTACHMENT_BYTES) {
    console.warn(
      '[Telegram] Skipping media %s (size=%d exceeds max=%d).',
      params.fileId,
      params.declaredFileSize,
      MAX_ATTACHMENT_BYTES,
    );
    return null;
  }

  const fileMetaResponse = await fetch(
    `https://api.telegram.org/bot${params.token}/getFile?file_id=${encodeURIComponent(params.fileId)}`,
  );
  if (!fileMetaResponse.ok) {
    const body = await fileMetaResponse.json().catch(() => ({}));
    throw new Error(`Telegram getFile failed: ${JSON.stringify(body)}`);
  }

  const fileMeta = (await fileMetaResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = fileMeta.result?.file_path?.trim();
  if (!fileMeta.ok || !filePath) {
    throw new Error(`Telegram getFile returned no file_path for ${params.fileId}`);
  }

  const resolvedFileSize = fileMeta.result?.file_size;
  if (typeof resolvedFileSize === 'number' && resolvedFileSize > MAX_ATTACHMENT_BYTES) {
    console.warn(
      '[Telegram] Skipping media %s (resolved size=%d exceeds max=%d).',
      params.fileId,
      resolvedFileSize,
      MAX_ATTACHMENT_BYTES,
    );
    return null;
  }

  const binaryResponse = await fetch(`https://api.telegram.org/file/bot${params.token}/${filePath}`);
  if (!binaryResponse.ok) {
    throw new Error(`Telegram file download failed (${binaryResponse.status})`);
  }

  const arrayBuffer = await binaryResponse.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    return null;
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    console.warn(
      '[Telegram] Skipping media %s (downloaded size=%d exceeds max=%d).',
      params.fileId,
      bytes.length,
      MAX_ATTACHMENT_BYTES,
    );
    return null;
  }

  const contentType = binaryResponse.headers.get('content-type')?.trim() || params.fallbackMimeType;
  return {
    name: params.fileName,
    type: contentType,
    size: bytes.length,
    dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
  };
}
