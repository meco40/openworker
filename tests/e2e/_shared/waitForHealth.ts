export async function waitForHealth(
  url: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
  throw new Error(`Timed out waiting for health endpoint ${url}: ${message}`);
}
