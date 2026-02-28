/**
 * Converts an unknown thrown value to a human-readable string.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
