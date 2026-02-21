import { getCredentialStore, type CredentialStore } from '@/server/channels/credentials';

export type BridgeChannel = 'whatsapp' | 'imessage';

export interface BridgeAccountSummary {
  accountId: string;
  pairingStatus: string | null;
  peerName: string | null;
  lastSeenAt: string | null;
  allowFrom: string[];
}

export interface BridgeAccountUpsertInput {
  accountId?: string;
  pairingStatus?: string;
  webhookSecret?: string;
  peerName?: string;
  touchLastSeen?: boolean;
}

const BRIDGE_ACCOUNT_IDS_KEY = 'bridge_accounts';
const DEFAULT_BRIDGE_ACCOUNT_ID = 'default';
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SCOPED_CHAT_PREFIX = 'acct:';
const ALLOW_FROM_SEPARATOR = ',';

function normalizeAccountIds(raw: string | null): string[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => (typeof value === 'string' ? normalizeBridgeAccountId(value) : null))
      .filter((value): value is string => Boolean(value));
  } catch {
    return raw
      .split(',')
      .map((part) => normalizeBridgeAccountId(part))
      .filter(Boolean);
  }
}

function accountKey(accountId: string, key: string): string {
  return `account.${accountId}.${key}`;
}

function normalizeAllowFromValue(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function writeAccountIds(channel: BridgeChannel, ids: string[], store: CredentialStore): void {
  const unique = Array.from(new Set(ids.map((id) => normalizeBridgeAccountId(id))));
  store.setCredential(channel, BRIDGE_ACCOUNT_IDS_KEY, JSON.stringify(unique));
}

function envWebhookSecret(channel: BridgeChannel): string {
  return channel === 'whatsapp'
    ? process.env.WHATSAPP_WEBHOOK_SECRET?.trim() || ''
    : process.env.IMESSAGE_WEBHOOK_SECRET?.trim() || '';
}

export function normalizeBridgeAccountId(accountId?: string | null): string {
  const raw = String(accountId || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return DEFAULT_BRIDGE_ACCOUNT_ID;
  }
  if (!ACCOUNT_ID_PATTERN.test(raw)) {
    throw new Error('Invalid accountId. Use lowercase letters, digits, "_" or "-", max 63 chars.');
  }
  return raw;
}

export function listBridgeAccountIds(
  channel: BridgeChannel,
  store: CredentialStore = getCredentialStore(),
): string[] {
  const ids = normalizeAccountIds(store.getCredential(channel, BRIDGE_ACCOUNT_IDS_KEY));
  if (ids.length > 0) {
    return ids;
  }

  const hasLegacy =
    Boolean(store.getCredential(channel, 'pairing_status')) ||
    Boolean(store.getCredential(channel, 'webhook_secret'));
  return hasLegacy ? [DEFAULT_BRIDGE_ACCOUNT_ID] : [];
}

export function resolveBridgeAccountSecret(
  channel: BridgeChannel,
  accountId?: string | null,
  store: CredentialStore = getCredentialStore(),
): string {
  const normalized = normalizeBridgeAccountId(accountId);
  const scoped = store.getCredential(channel, accountKey(normalized, 'webhook_secret'))?.trim();
  if (scoped) {
    return scoped;
  }

  if (normalized === DEFAULT_BRIDGE_ACCOUNT_ID) {
    const legacy = store.getCredential(channel, 'webhook_secret')?.trim();
    if (legacy) {
      return legacy;
    }
  }

  return envWebhookSecret(channel);
}

function resolveBridgeAccountStatus(
  channel: BridgeChannel,
  accountId?: string | null,
  store: CredentialStore = getCredentialStore(),
): string | null {
  const normalized = normalizeBridgeAccountId(accountId);
  const scoped = store.getCredential(channel, accountKey(normalized, 'pairing_status'));
  if (scoped) {
    return scoped;
  }
  if (normalized === DEFAULT_BRIDGE_ACCOUNT_ID) {
    return store.getCredential(channel, 'pairing_status');
  }
  return null;
}

export function upsertBridgeAccount(
  channel: BridgeChannel,
  input: BridgeAccountUpsertInput,
  store: CredentialStore = getCredentialStore(),
): string {
  const accountId = normalizeBridgeAccountId(input.accountId);
  const now = new Date().toISOString();
  const ids = listBridgeAccountIds(channel, store);
  if (!ids.includes(accountId)) {
    writeAccountIds(channel, [...ids, accountId], store);
  }

  if (input.webhookSecret !== undefined) {
    store.setCredential(channel, accountKey(accountId, 'webhook_secret'), input.webhookSecret);
    if (accountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
      store.setCredential(channel, 'webhook_secret', input.webhookSecret);
    }
  }
  if (input.pairingStatus !== undefined) {
    store.setCredential(channel, accountKey(accountId, 'pairing_status'), input.pairingStatus);
    if (accountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
      store.setCredential(channel, 'pairing_status', input.pairingStatus);
    }
  }
  if (input.peerName !== undefined) {
    store.setCredential(channel, accountKey(accountId, 'peer_name'), input.peerName);
  }
  if (input.touchLastSeen) {
    store.setCredential(channel, accountKey(accountId, 'last_seen_at'), now);
  }
  store.setCredential(channel, accountKey(accountId, 'updated_at'), now);

  return accountId;
}

export function listBridgeAccounts(
  channel: BridgeChannel,
  store: CredentialStore = getCredentialStore(),
): BridgeAccountSummary[] {
  const ids = listBridgeAccountIds(channel, store);
  return ids.map((accountId) => ({
    accountId,
    pairingStatus: resolveBridgeAccountStatus(channel, accountId, store),
    peerName: store.getCredential(channel, accountKey(accountId, 'peer_name')),
    lastSeenAt: store.getCredential(channel, accountKey(accountId, 'last_seen_at')),
    allowFrom: readBridgeAccountAllowFrom(channel, accountId, store),
  }));
}

export function removeBridgeAccount(
  channel: BridgeChannel,
  accountId?: string | null,
  store: CredentialStore = getCredentialStore(),
): void {
  const normalized = normalizeBridgeAccountId(accountId);
  const credentials = store.listCredentials(channel);
  const prefix = `account.${normalized}.`;
  for (const entry of credentials) {
    if (entry.key.startsWith(prefix)) {
      store.deleteCredential(channel, entry.key);
    }
  }

  const remaining = listBridgeAccountIds(channel, store).filter((id) => id !== normalized);
  writeAccountIds(channel, remaining, store);

  if (normalized === DEFAULT_BRIDGE_ACCOUNT_ID) {
    store.deleteCredential(channel, 'pairing_status');
    store.deleteCredential(channel, 'webhook_secret');
  }
}

export function resolveBridgeAccountIdFromRequest(params: {
  request: Request;
  bodyAccountId?: unknown;
}): string {
  const bodyAccountId = typeof params.bodyAccountId === 'string' ? params.bodyAccountId : undefined;
  const headerAccountId = params.request.headers.get('x-openclaw-account-id') || undefined;
  const urlAccountId = new URL(params.request.url).searchParams.get('accountId') || undefined;
  return normalizeBridgeAccountId(bodyAccountId || headerAccountId || urlAccountId);
}

export function readBridgeAccountAllowFrom(
  channel: BridgeChannel,
  accountId?: string | null,
  store: CredentialStore = getCredentialStore(),
): string[] {
  const normalizedAccountId = normalizeBridgeAccountId(accountId);
  const raw =
    store.getCredential(channel, accountKey(normalizedAccountId, 'allow_from')) ||
    (normalizedAccountId === DEFAULT_BRIDGE_ACCOUNT_ID
      ? store.getCredential(channel, 'allow_from')
      : null) ||
    '';
  return raw
    .split(ALLOW_FROM_SEPARATOR)
    .map(normalizeAllowFromValue)
    .filter(Boolean)
    .filter((value, index, source) => source.indexOf(value) === index);
}

export function writeBridgeAccountAllowFrom(
  channel: BridgeChannel,
  accountId: string,
  allowFrom: string[],
  store: CredentialStore = getCredentialStore(),
): string[] {
  const normalizedAccountId = normalizeBridgeAccountId(accountId);
  const normalized = allowFrom
    .map(normalizeAllowFromValue)
    .filter(Boolean)
    .filter((value, index, source) => source.indexOf(value) === index);
  const serialized = normalized.join(ALLOW_FROM_SEPARATOR);
  store.setCredential(channel, accountKey(normalizedAccountId, 'allow_from'), serialized);
  if (normalizedAccountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
    store.setCredential(channel, 'allow_from', serialized);
  }
  return normalized;
}

export function scopeBridgeExternalChatId(accountId: string, externalChatId: string): string {
  const normalizedAccountId = normalizeBridgeAccountId(accountId);
  if (normalizedAccountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
    return externalChatId;
  }
  const encodedAccountId = Buffer.from(normalizedAccountId, 'utf8').toString('base64url');
  return `${SCOPED_CHAT_PREFIX}${encodedAccountId}:${externalChatId}`;
}

export function parseScopedBridgeExternalChatId(scopedExternalChatId: string): {
  accountId: string;
  externalChatId: string;
} {
  const normalized = String(scopedExternalChatId || '').trim();
  if (!normalized.startsWith(SCOPED_CHAT_PREFIX)) {
    return {
      accountId: DEFAULT_BRIDGE_ACCOUNT_ID,
      externalChatId: normalized,
    };
  }

  const payload = normalized.slice(SCOPED_CHAT_PREFIX.length);
  const separator = payload.indexOf(':');
  if (separator <= 0) {
    return {
      accountId: DEFAULT_BRIDGE_ACCOUNT_ID,
      externalChatId: normalized,
    };
  }

  try {
    const encodedAccountId = payload.slice(0, separator);
    const externalChatId = payload.slice(separator + 1);
    const accountId = normalizeBridgeAccountId(
      Buffer.from(encodedAccountId, 'base64url').toString('utf8'),
    );
    return {
      accountId,
      externalChatId,
    };
  } catch {
    return {
      accountId: DEFAULT_BRIDGE_ACCOUNT_ID,
      externalChatId: normalized,
    };
  }
}
