import crypto from 'node:crypto';

// ─── Webhook Authentication Utilities ────────────────────────
// Verifies that incoming webhook requests originate from the expected platform.

let insecureWebhookWarningLogged = false;

/** Constant-time secret comparison. Hashing both sides fixes the lengths, so length does not leak. */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const providedDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export function allowInsecureWebhookFallback(): boolean {
  const enabled = process.env.ALLOW_INSECURE_WEBHOOKS === 'true';
  if (!enabled) return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NODE_ENV === 'test') return true;

  if (!insecureWebhookWarningLogged) {
    insecureWebhookWarningLogged = true;
    console.warn(
      '[SECURITY WARNING] ALLOW_INSECURE_WEBHOOKS=true enabled. Missing webhook secrets are accepted in non-production environments.',
    );
  }

  return true;
}

/**
 * Verifies the Telegram webhook secret token header.
 * Telegram sends the secret_token (set during setWebhook) in the
 * `X-Telegram-Bot-Api-Secret-Token` header on each webhook delivery.
 */
export function verifyTelegramWebhook(request: Request, secretToken: string): boolean {
  if (!secretToken) return allowInsecureWebhookFallback();
  const header = request.headers.get('x-telegram-bot-api-secret-token');
  return secretsMatch(header, secretToken);
}

/**
 * Verifies a shared secret header.
 * Used for WhatsApp/iMessage bridge webhooks where we control the bridge
 * and can set a shared secret during pairing.
 */
export function verifySharedSecret(request: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return allowInsecureWebhookFallback();
  const header = request.headers.get('x-webhook-secret');
  return secretsMatch(header, expectedSecret);
}
