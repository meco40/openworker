import crypto from 'node:crypto';

// ─── Webhook Authentication Utilities ────────────────────────
// Verifies that incoming webhook requests originate from the expected platform.

let insecureWebhookWarningLogged = false;

function allowInsecureWebhookFallback(): boolean {
  const enabled = process.env.ALLOW_INSECURE_WEBHOOKS === 'true';
  if (!enabled) return false;
  if (process.env.NODE_ENV === 'production') return false;

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
  return header === secretToken;
}

/**
 * Verifies an Ed25519 signature for Discord webhook requests.
 * Discord sends `X-Signature-Ed25519` and `X-Signature-Timestamp` headers.
 * The signed payload is `timestamp + body`.
 */
export async function verifyDiscordWebhook(
  request: Request,
  publicKeyHex: string,
  body: string,
): Promise<boolean> {
  if (!publicKeyHex) return allowInsecureWebhookFallback();

  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  if (!signature || !timestamp) return false;

  try {
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    const signatureBytes = Buffer.from(signature, 'hex');
    const message = Buffer.from(timestamp + body);

    // Use Node.js crypto.verify with Ed25519
    return crypto.verify(
      undefined, // Ed25519 does not use a separate hash algorithm
      message,
      {
        key: crypto.createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' }),
        dsaEncoding: undefined as never,
      },
      signatureBytes,
    );
  } catch {
    // If the key format or signature is invalid, reject
    return false;
  }
}

/**
 * Verifies a shared secret header.
 * Used for WhatsApp/iMessage bridge webhooks where we control the bridge
 * and can set a shared secret during pairing.
 */
export function verifySharedSecret(request: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return allowInsecureWebhookFallback();
  const header = request.headers.get('x-webhook-secret');
  return header === expectedSecret;
}
