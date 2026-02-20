export type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  chatType: 'direct' | 'group' | 'unknown';
};

function resolveTelegramChatType(chatId: string): 'direct' | 'group' | 'unknown' {
  const trimmed = chatId.trim();
  if (!trimmed) return 'unknown';
  if (/^-?\d+$/.test(trimmed)) {
    return trimmed.startsWith('-') ? 'group' : 'direct';
  }
  return 'unknown';
}

export function stripTelegramInternalPrefixes(target: string): string {
  let current = target.trim();
  let strippedTelegramPrefix = false;

  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(current)) {
        strippedTelegramPrefix = true;
        return current.replace(/^(telegram|tg):/i, '').trim();
      }
      if (strippedTelegramPrefix && /^group:/i.test(current)) {
        return current.replace(/^group:/i, '').trim();
      }
      return current;
    })();

    if (next === current) {
      return current;
    }
    current = next;
  }
}

export function parseTelegramTarget(target: string): TelegramTarget {
  const normalized = stripTelegramInternalPrefixes(target);

  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    const chatId = topicMatch[1];
    return {
      chatId,
      messageThreadId: Number.parseInt(topicMatch[2], 10),
      chatType: resolveTelegramChatType(chatId),
    };
  }

  const compactTopicMatch = /^(.+):(\d+)$/.exec(normalized);
  if (compactTopicMatch) {
    const chatId = compactTopicMatch[1];
    return {
      chatId,
      messageThreadId: Number.parseInt(compactTopicMatch[2], 10),
      chatType: resolveTelegramChatType(chatId),
    };
  }

  return {
    chatId: normalized,
    chatType: resolveTelegramChatType(normalized),
  };
}

export function resolveTelegramTargetChatType(target: string): TelegramTarget['chatType'] {
  return parseTelegramTarget(target).chatType;
}
