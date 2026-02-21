export function formatTimestamp(input?: string): string {
  if (!input) {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return input;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
