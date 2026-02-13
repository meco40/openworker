import crypto from 'node:crypto';

interface OauthStatePayload {
  providerId: string;
  label: string;
  createdAt: number;
  nonce: string;
  codeVerifier?: string;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function toBase64Url(input: Buffer | string): string {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return source.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(`${normalized}${'='.repeat(padLength)}`, 'base64');
}

function signState(serializedPayload: string, signingKey: string): string {
  return toBase64Url(crypto.createHmac('sha256', signingKey).update(serializedPayload).digest());
}

export function createOAuthState(payload: OauthStatePayload, signingKey: string): string {
  const serializedPayload = JSON.stringify(payload);
  const encodedPayload = toBase64Url(serializedPayload);
  const signature = signState(serializedPayload, signingKey);
  return `${encodedPayload}.${signature}`;
}

export function parseOAuthState(state: string, signingKey: string): OauthStatePayload {
  const [payloadPart, signaturePart] = state.split('.');
  if (!payloadPart || !signaturePart) {
    throw new Error('Invalid OAuth state format.');
  }

  const serializedPayload = fromBase64Url(payloadPart).toString('utf8');
  const expected = signState(serializedPayload, signingKey);
  if (signaturePart !== expected) {
    throw new Error('Invalid OAuth state signature.');
  }

  const payload = JSON.parse(serializedPayload) as OauthStatePayload;
  if (!payload.providerId || !payload.label || !payload.createdAt || !payload.nonce) {
    throw new Error('OAuth state payload is incomplete.');
  }

  const age = Date.now() - payload.createdAt;
  if (age > OAUTH_STATE_TTL_MS) {
    throw new Error('OAuth state expired.');
  }

  return payload;
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(crypto.randomBytes(32));
  const codeChallenge = toBase64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function createOAuthNonce(): string {
  return toBase64Url(crypto.randomBytes(16));
}
