import type { RateLimitSnapshot, RateLimitWindow } from '@/components/model-hub/types';

interface CodexRateLimitWindows {
  shortWindow?: RateLimitWindow;
  longWindow?: RateLimitWindow;
}

export function formatCodexRateLimitLabel(
  windowLabel: string,
  window?: { limit?: number; remaining?: number; remainingPercent?: number },
): string {
  if (!window) return windowLabel;
  if (typeof window.remaining === 'number' && typeof window.limit === 'number') {
    return `${windowLabel} ${window.remaining}/${window.limit}`;
  }
  if (typeof window.remainingPercent === 'number') {
    return `${windowLabel} ${window.remainingPercent}%`;
  }
  if (typeof window.remaining === 'number') {
    return `${windowLabel} ${window.remaining}`;
  }
  if (typeof window.limit === 'number') {
    return `${windowLabel} ${window.limit}`;
  }
  return windowLabel;
}

export function resolveCodexRateLimitWindows(
  snapshot: RateLimitSnapshot | null | undefined,
): CodexRateLimitWindows {
  const windowsByName = new Map(
    (snapshot?.windows ?? []).map((window) => [window.window.toLowerCase(), window]),
  );
  const shortWindowKey = windowsByName.has('5h')
    ? '5h'
    : (Array.from(windowsByName.keys()).find((key) => key.endsWith('h')) ?? null);
  const longWindowKey = windowsByName.has('5d')
    ? '5d'
    : (Array.from(windowsByName.keys()).find(
        (key) => key.endsWith('d') && key !== shortWindowKey,
      ) ?? null);

  return {
    shortWindow: shortWindowKey ? windowsByName.get(shortWindowKey) : undefined,
    longWindow: longWindowKey ? windowsByName.get(longWindowKey) : undefined,
  };
}
