/**
 * notifications handler — Send webhooks and emails.
 *
 * webhook_send(url, payload, headers?)       — POST JSON to an arbitrary URL
 * email_send(to, subject, body, from?)       — Send email via SMTP (nodemailer)
 *
 * Gated by env: OPENCLAW_NOTIFICATIONS_ENABLED=true
 * SMTP config: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import type { SkillDispatchContext } from '@/server/skills/types';

type NotificationAction = 'webhook_send' | 'email_send';

interface NotificationsArgs {
  action: NotificationAction;
  // webhook
  url?: string;
  payload?: unknown;
  headers?: Record<string, string>;
  // email
  to?: string | string[];
  subject?: string;
  body?: string;
  from?: string;
}

const BLOCKED_PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc|^fd/,
  /^localhost$/i,
];

function assertUrlAllowed(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  for (const pattern of BLOCKED_PRIVATE_RANGES) {
    if (pattern.test(hostname)) {
      throw new Error(`Blocked: private/loopback URL not allowed (${hostname})`);
    }
  }
}

async function sendWebhook(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  if (process.env.OPENCLAW_NOTIFICATIONS_ENABLED !== 'true') {
    return { error: 'Webhook skill disabled. Set OPENCLAW_NOTIFICATIONS_ENABLED=true to enable.' };
  }

  assertUrlAllowed(url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text().catch(() => '');
  return {
    status: response.status,
    statusText: response.statusText,
    body: responseText.slice(0, 2000),
  };
}

async function sendEmail(
  to: string | string[],
  subject: string,
  body: string,
  from?: string,
): Promise<Record<string, unknown>> {
  if (process.env.OPENCLAW_NOTIFICATIONS_ENABLED !== 'true') {
    return { error: 'Email skill disabled. Set OPENCLAW_NOTIFICATIONS_ENABLED=true to enable.' };
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return {
      error:
        'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT, SMTP_FROM) environment variables.',
    };
  }

  // Dynamic import to avoid loading nodemailer at startup
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ? parseInt(SMTP_PORT, 10) : 587,
    secure: SMTP_PORT === '465',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: from || SMTP_FROM || SMTP_USER,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    text: body,
  });

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

export async function notificationsHandler(
  args: Record<string, unknown>,
  _context?: SkillDispatchContext,
) {
  const typed = args as unknown as NotificationsArgs;
  const action = typed.action;

  if (action === 'webhook_send') {
    if (!typed.url) return { error: 'url is required for webhook_send' };
    return sendWebhook(typed.url, typed.payload ?? {}, typed.headers ?? {});
  }

  if (action === 'email_send') {
    if (!typed.to) return { error: 'to is required for email_send' };
    if (!typed.subject) return { error: 'subject is required for email_send' };
    if (!typed.body) return { error: 'body is required for email_send' };
    return sendEmail(typed.to, typed.subject, typed.body, typed.from);
  }

  return { error: `Unknown action: ${String(action)}. Valid: webhook_send, email_send` };
}
