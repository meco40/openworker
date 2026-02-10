import crypto from 'node:crypto';

export interface EncryptedSecretPayload {
  alg: 'aes-256-gcm';
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

function normalizeKey(input: string): Buffer {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const bytes = Buffer.from(trimmed, 'utf8');
  if (bytes.length !== 32) {
    throw new Error('Encryption key must be 32 UTF-8 bytes or 64 hex chars.');
  }
  return bytes;
}

export function maskSecret(secret: string): string {
  const tail = secret.slice(-4);
  const stars = '*'.repeat(Math.max(8, secret.length - 4));
  return `${stars}${tail}`;
}

export function encryptSecret(secret: string, key: string, keyId = 'default'): EncryptedSecretPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', normalizeKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(payload: EncryptedSecretPayload, key: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    normalizeKey(key),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
