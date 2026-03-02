interface ErrorPayload {
  ok?: boolean;
  error?: string;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function readJsonOrThrow<T extends ErrorPayload>(response: Response): Promise<T> {
  const payload = (await response.json()) as T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}
