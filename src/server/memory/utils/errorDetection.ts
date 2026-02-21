export function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /http\s*404/i.test(message);
}

export function isLegacyDeleteNotFoundError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!/http\s*500/i.test(message)) return false;
  return (
    (message.includes('nonetype') && message.includes('payload')) ||
    message.includes('memory not found') ||
    message.includes('not found')
  );
}
