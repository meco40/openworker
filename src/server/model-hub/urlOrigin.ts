const INVALID_BROWSER_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

export function normalizeBrowserOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (INVALID_BROWSER_HOSTS.has(url.hostname)) {
      url.hostname = 'localhost';
      return url.origin;
    }
    return url.origin;
  } catch {
    return origin;
  }
}

export function buildModelHubCallbackUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const origin = normalizeBrowserOrigin(url.origin);
  return `${origin}/api/model-hub/oauth/callback`;
}
