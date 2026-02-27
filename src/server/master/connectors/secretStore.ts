import crypto from 'node:crypto';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterConnectorSecret, WorkspaceScope } from '@/server/master/types';

const SECRET_PREFIX = 'enc:v1:';
const SECRET_PREFIX_V2 = 'enc:v2:';

let cachedSecretKey: Buffer | null = null;

function resolveSecretKey(): Buffer {
  if (cachedSecretKey) return cachedSecretKey;
  const configured = String(process.env.OPENCLAW_MASTER_SECRET_KEY || '').trim();
  if (configured) {
    const base64Candidate = Buffer.from(configured, 'base64');
    if (base64Candidate.length === 32) {
      cachedSecretKey = base64Candidate;
      return cachedSecretKey;
    }
    const hexCandidate = Buffer.from(configured, 'hex');
    if (hexCandidate.length === 32) {
      cachedSecretKey = hexCandidate;
      return cachedSecretKey;
    }
    cachedSecretKey = crypto.createHash('sha256').update(configured).digest();
    return cachedSecretKey;
  }
  cachedSecretKey = crypto.createHash('sha256').update(`openclaw-master:${process.cwd()}`).digest();
  return cachedSecretKey;
}

export function encryptConnectorSecret(plainText: string): string {
  const key = resolveSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SECRET_PREFIX_V2}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptConnectorSecret(cipherText: string): string {
  if (cipherText.startsWith(SECRET_PREFIX_V2)) {
    const payload = cipherText.slice(SECRET_PREFIX_V2.length);
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('Unsupported secret format.');
    }
    const [ivRaw, tagRaw, encryptedRaw] = parts;
    const iv = Buffer.from(ivRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    const encrypted = Buffer.from(encryptedRaw, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', resolveSecretKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }
  if (!cipherText.startsWith(SECRET_PREFIX)) {
    throw new Error('Unsupported secret format.');
  }
  return Buffer.from(cipherText.slice(SECRET_PREFIX.length), 'base64url').toString('utf8');
}

export function storeConnectorSecret(
  repo: MasterRepository,
  scope: WorkspaceScope,
  input: { provider: string; keyRef: string; plainText: string; expiresAt?: string | null },
): MasterConnectorSecret {
  const stored = repo.upsertConnectorSecret(scope, {
    provider: input.provider,
    keyRef: input.keyRef,
    encryptedPayload: encryptConnectorSecret(input.plainText),
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  });
  repo.appendAuditEvent(scope, {
    category: 'connector_secret',
    action: 'store',
    metadata: JSON.stringify({
      provider: input.provider,
      keyRef: input.keyRef,
      expiresAt: input.expiresAt ?? null,
    }),
  });
  return stored;
}
