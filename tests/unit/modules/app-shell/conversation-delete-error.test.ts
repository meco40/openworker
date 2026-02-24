import { describe, expect, it } from 'vitest';
import { buildConversationDeleteErrorMessage } from '@/modules/app-shell/conversationDeleteError';

describe('buildConversationDeleteErrorMessage', () => {
  it('returns user-friendly server error message for 5xx responses', () => {
    const message = buildConversationDeleteErrorMessage({
      status: 500,
      payloadError: 'SqliteError: FOREIGN KEY constraint failed',
    });

    expect(message).toBe('Serverfehler beim Löschen der Conversation. Bitte versuche es erneut.');
  });

  it('returns not-found message for 404 responses', () => {
    const message = buildConversationDeleteErrorMessage({
      status: 404,
      payloadError: 'Conversation not found',
    });

    expect(message).toBe('Conversation wurde nicht gefunden oder ist bereits gelöscht.');
  });

  it('uses API message for non-5xx responses when available', () => {
    const message = buildConversationDeleteErrorMessage({
      status: 400,
      payloadError: 'Ungültige Anfrage.',
    });

    expect(message).toBe('Ungültige Anfrage.');
  });

  it('falls back to provided fallback text when payload is empty', () => {
    const message = buildConversationDeleteErrorMessage({
      status: 400,
      payloadError: '',
      fallback: 'Conversation konnte nicht gelöscht werden.',
    });

    expect(message).toBe('Conversation konnte nicht gelöscht werden.');
  });
});
