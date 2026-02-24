interface ConversationDeleteErrorInput {
  status: number;
  payloadError?: string | null;
  fallback?: string;
}

const DEFAULT_FALLBACK = 'Conversation konnte nicht gelöscht werden.';

export function buildConversationDeleteErrorMessage(input: ConversationDeleteErrorInput): string {
  const status = Number.isFinite(input.status) ? input.status : 0;
  const payloadError = String(input.payloadError || '').trim();
  const fallback = String(input.fallback || '').trim() || DEFAULT_FALLBACK;

  if (status >= 500) {
    return 'Serverfehler beim Löschen der Conversation. Bitte versuche es erneut.';
  }

  if (status === 404) {
    return 'Conversation wurde nicht gefunden oder ist bereits gelöscht.';
  }

  if (payloadError) {
    return payloadError;
  }

  return fallback;
}
