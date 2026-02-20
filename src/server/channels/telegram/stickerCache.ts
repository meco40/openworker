type StickerSummaryEntry = {
  summary: string;
  updatedAt: number;
};

const MAX_STICKER_CACHE_SIZE = 512;
const stickerSummaryCache = new Map<string, StickerSummaryEntry>();

export function getStickerSummary(fileUniqueId: string): string | null {
  const key = fileUniqueId.trim();
  if (!key) return null;
  const cached = stickerSummaryCache.get(key);
  return cached?.summary || null;
}

export function setStickerSummary(fileUniqueId: string, summary: string): void {
  const key = fileUniqueId.trim();
  const value = summary.trim();
  if (!key || !value) return;

  if (stickerSummaryCache.size >= MAX_STICKER_CACHE_SIZE) {
    const oldestKey = stickerSummaryCache.keys().next().value;
    if (oldestKey) stickerSummaryCache.delete(oldestKey);
  }

  stickerSummaryCache.set(key, {
    summary: value,
    updatedAt: Date.now(),
  });
}

export function buildStickerSummary(params: { emoji?: string; setName?: string }): string {
  const emoji = params.emoji?.trim();
  const setName = params.setName?.trim();
  if (emoji && setName) return `[Sticker ${emoji} from ${setName}]`;
  if (emoji) return `[Sticker ${emoji}]`;
  if (setName) return `[Sticker from ${setName}]`;
  return '[Sticker]';
}
