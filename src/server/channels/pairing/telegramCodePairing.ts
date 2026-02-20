import crypto from 'node:crypto';
import { getCredentialStore } from '@/server/channels/credentials';

const CHANNEL = 'telegram';

const KEY_PAIRING_STATUS = 'pairing_status';
const KEY_PAIRED_CHAT_ID = 'paired_chat_id';
const KEY_PENDING_CHAT_ID = 'pending_chat_id';
const KEY_PENDING_CODE = 'pending_code';
const KEY_PENDING_EXPIRES_AT = 'pending_expires_at';

const CODE_TTL_MS = 10 * 60 * 1000;

export type TelegramChannelStatus = 'awaiting_code' | 'connected';

export type EnsureTelegramPairingCodeResult =
  | { kind: 'issued'; code: string; expiresAt: string; reused: boolean }
  | { kind: 'blocked'; pendingChatId: string; expiresAt: string }
  | { kind: 'already_bound'; pairedChatId: string }
  | { kind: 'already_connected' };

export interface TelegramPairingConfirmResult {
  ok: boolean;
  chatId?: string;
  error?: string;
}

function clearPendingPairingCode(): void {
  const store = getCredentialStore();
  store.setCredential(CHANNEL, KEY_PENDING_CHAT_ID, '');
  store.setCredential(CHANNEL, KEY_PENDING_CODE, '');
  store.setCredential(CHANNEL, KEY_PENDING_EXPIRES_AT, '');
}

function readPendingPairingState(): {
  pendingChatId: string | null;
  pendingCode: string | null;
  pendingExpiresAt: Date | null;
} {
  const store = getCredentialStore();

  const pendingChatId = store.getCredential(CHANNEL, KEY_PENDING_CHAT_ID) || null;
  const pendingCode = store.getCredential(CHANNEL, KEY_PENDING_CODE) || null;
  const pendingExpiresRaw = store.getCredential(CHANNEL, KEY_PENDING_EXPIRES_AT);
  const pendingExpiresAt = pendingExpiresRaw ? new Date(pendingExpiresRaw) : null;

  if (!pendingExpiresAt || Number.isNaN(pendingExpiresAt.valueOf())) {
    return { pendingChatId, pendingCode, pendingExpiresAt: null };
  }

  return { pendingChatId, pendingCode, pendingExpiresAt };
}

function generateSixDigitCode(): string {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, '0');
}

export function beginTelegramCodePairing(): void {
  const store = getCredentialStore();
  store.setCredential(CHANNEL, KEY_PAIRING_STATUS, 'awaiting_code');
  store.setCredential(CHANNEL, KEY_PAIRED_CHAT_ID, '');
  clearPendingPairingCode();
}

export function ensureTelegramPairingCode(
  chatId: string,
  now = new Date(),
): EnsureTelegramPairingCodeResult {
  const store = getCredentialStore();
  const status = store.getCredential(CHANNEL, KEY_PAIRING_STATUS);
  const pairedChatId = store.getCredential(CHANNEL, KEY_PAIRED_CHAT_ID);

  if (status === 'connected' && pairedChatId) {
    if (pairedChatId === chatId) {
      return { kind: 'already_connected' };
    }
    return { kind: 'already_bound', pairedChatId };
  }

  if (isTelegramChatAuthorized(chatId)) {
    return { kind: 'already_connected' };
  }

  const { pendingChatId, pendingCode, pendingExpiresAt } = readPendingPairingState();
  const hasActivePending =
    !!pendingChatId &&
    !!pendingCode &&
    !!pendingExpiresAt &&
    pendingExpiresAt.valueOf() > now.valueOf();

  if (hasActivePending) {
    if (pendingChatId !== chatId) {
      return {
        kind: 'blocked',
        pendingChatId,
        expiresAt: pendingExpiresAt.toISOString(),
      };
    }

    return {
      kind: 'issued',
      code: pendingCode,
      expiresAt: pendingExpiresAt.toISOString(),
      reused: true,
    };
  }

  const code = generateSixDigitCode();
  const expiresAt = new Date(now.valueOf() + CODE_TTL_MS);
  store.setCredential(CHANNEL, KEY_PAIRING_STATUS, 'awaiting_code');
  store.setCredential(CHANNEL, KEY_PENDING_CHAT_ID, chatId);
  store.setCredential(CHANNEL, KEY_PENDING_CODE, code);
  store.setCredential(CHANNEL, KEY_PENDING_EXPIRES_AT, expiresAt.toISOString());

  return {
    kind: 'issued',
    code,
    expiresAt: expiresAt.toISOString(),
    reused: false,
  };
}

export function confirmTelegramPairingCode(
  providedCode: string,
  now = new Date(),
): TelegramPairingConfirmResult {
  const normalized = providedCode.trim();
  if (!normalized) {
    return { ok: false, error: 'Pairing code is required.' };
  }

  const store = getCredentialStore();
  const { pendingChatId, pendingCode, pendingExpiresAt } = readPendingPairingState();

  if (!pendingChatId || !pendingCode || !pendingExpiresAt) {
    return { ok: false, error: 'No active Telegram pairing request.' };
  }

  if (pendingExpiresAt.valueOf() <= now.valueOf()) {
    clearPendingPairingCode();
    return {
      ok: false,
      error: 'Pairing code has expired. Send a new Telegram message to get a fresh code.',
    };
  }

  if (pendingCode !== normalized) {
    return { ok: false, error: 'Invalid pairing code.' };
  }

  store.setCredential(CHANNEL, KEY_PAIRING_STATUS, 'connected');
  store.setCredential(CHANNEL, KEY_PAIRED_CHAT_ID, pendingChatId);
  clearPendingPairingCode();

  return { ok: true, chatId: pendingChatId };
}

export function isTelegramChatAuthorized(chatId: string): boolean {
  const store = getCredentialStore();
  const status = store.getCredential(CHANNEL, KEY_PAIRING_STATUS);
  const pairedChatId = store.getCredential(CHANNEL, KEY_PAIRED_CHAT_ID);
  return status === 'connected' && !!pairedChatId && pairedChatId === chatId;
}

export function migrateTelegramPairedChatId(oldChatId: string, newChatId: string): boolean {
  const normalizedOld = oldChatId.trim();
  const normalizedNew = newChatId.trim();
  if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
    return false;
  }

  const store = getCredentialStore();
  let changed = false;

  const pairedChatId = store.getCredential(CHANNEL, KEY_PAIRED_CHAT_ID);
  if (pairedChatId === normalizedOld) {
    store.setCredential(CHANNEL, KEY_PAIRED_CHAT_ID, normalizedNew);
    changed = true;
  }

  const pendingChatId = store.getCredential(CHANNEL, KEY_PENDING_CHAT_ID);
  if (pendingChatId === normalizedOld) {
    store.setCredential(CHANNEL, KEY_PENDING_CHAT_ID, normalizedNew);
    changed = true;
  }

  return changed;
}
