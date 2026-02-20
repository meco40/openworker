export function resolveTelegramVoiceLabel(params: {
  voice?: { duration?: number };
  audio?: { duration?: number; title?: string; performer?: string };
}): string | null {
  if (params.voice) {
    const duration = typeof params.voice.duration === 'number' ? params.voice.duration : null;
    return duration ? `[Voice message, ${duration}s]` : '[Voice message]';
  }

  if (params.audio) {
    const duration = typeof params.audio.duration === 'number' ? params.audio.duration : null;
    const title = params.audio.title?.trim();
    const performer = params.audio.performer?.trim();
    const parts = [performer, title].filter((entry): entry is string => Boolean(entry));
    if (parts.length > 0 && duration) {
      return `[Audio: ${parts.join(' - ')} (${duration}s)]`;
    }
    if (parts.length > 0) {
      return `[Audio: ${parts.join(' - ')}]`;
    }
    return duration ? `[Audio message, ${duration}s]` : '[Audio message]';
  }

  return null;
}
