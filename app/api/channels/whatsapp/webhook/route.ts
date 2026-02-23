import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getMessageService } from '@/server/channels/messages/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import {
  persistIncomingAttachment,
  type IncomingMessageAttachmentPayload,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import { verifySharedSecret } from '@/server/channels/webhookAuth';
import { ChannelType } from '@/shared/domain/types';
import { normalizeWhatsAppInbound } from '@/server/channels/inbound/normalizers';
import {
  readBridgeAccountAllowFrom,
  resolveBridgeAccountIdFromRequest,
  resolveBridgeAccountSecret,
  scopeBridgeExternalChatId,
  upsertBridgeAccount,
} from '@/server/channels/pairing/bridgeAccounts';
import { getCredentialStore } from '@/server/channels/credentials';

export const runtime = 'nodejs';

interface WhatsAppAttachmentPayload {
  name?: string;
  type?: string;
  size?: number;
  dataUrl?: string;
  url?: string;
}

interface WhatsAppWebhookPayload {
  accountId?: string;
  from?: string;
  chatId?: string;
  body?: string;
  messageId?: string;
  senderName?: string;
  timestamp?: number | string;
  attachments?: WhatsAppAttachmentPayload[];
  attachment?: WhatsAppAttachmentPayload;
}

const MEDIA_FETCH_TIMEOUT_MS = Number(process.env.WHATSAPP_WEBHOOK_MEDIA_TIMEOUT_MS || 5000);
const DEFAULT_MEDIA_MIME_TYPE = 'application/octet-stream';

function normalizeSender(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function resolveAllowFromValues(accountId: string): string[] {
  const store = getCredentialStore();
  const envAccountKey = `WHATSAPP_ALLOW_FROM_${accountId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const merged = [
    readBridgeAccountAllowFrom('whatsapp', accountId, store).join(','),
    process.env[envAccountKey] || '',
    process.env.WHATSAPP_ALLOW_FROM || '',
  ]
    .join(',')
    .split(',')
    .map((entry) => normalizeSender(entry))
    .filter(Boolean);
  return Array.from(new Set(merged));
}

function isSenderAllowed(sender: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) {
    return true;
  }
  const normalizedSender = normalizeSender(sender);
  if (!normalizedSender) {
    return false;
  }
  return allowFrom.some(
    (allowed) => normalizedSender.includes(allowed) || allowed.includes(normalizedSender),
  );
}

function buildFallbackMessageId(payload: WhatsAppWebhookPayload, accountId: string): string {
  const seed = [
    accountId,
    payload.chatId || payload.from || '',
    payload.body || '',
    String(payload.timestamp || ''),
  ].join('|');
  return `wa-auto-${createHash('sha1').update(seed).digest('hex')}`;
}

async function fetchAttachmentDataUrl(
  url: string,
  declaredType?: string,
): Promise<{ dataUrl: string; mimeType: string; size: number }> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Attachment URL protocol is not allowed.');
  }

  const allowedHosts = (process.env.WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Attachment host is not allowed: ${parsed.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Attachment fetch failed with status ${response.status}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType =
      declaredType?.trim() ||
      response.headers.get('content-type')?.split(';')[0]?.trim() ||
      DEFAULT_MEDIA_MIME_TYPE;
    return {
      dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
      mimeType: contentType,
      size: bytes.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveInboundAttachments(params: {
  payload: WhatsAppWebhookPayload;
  accountId: string;
  scopedChatId: string;
  personaSlug?: string | null;
}): Promise<StoredMessageAttachment[]> {
  const enableRemoteFetch = String(process.env.WHATSAPP_WEBHOOK_FETCH_MEDIA || 'false') === 'true';
  const entries = [...(params.payload.attachments || [])];
  if (params.payload.attachment) {
    entries.push(params.payload.attachment);
  }

  const attachments: StoredMessageAttachment[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    let payload: IncomingMessageAttachmentPayload | null = null;
    if (entry.dataUrl?.trim()) {
      payload = {
        name: String(entry.name || 'attachment'),
        type: String(entry.type || ''),
        size:
          typeof entry.size === 'number' && Number.isFinite(entry.size)
            ? Math.max(0, Math.floor(entry.size))
            : 0,
        dataUrl: entry.dataUrl,
      };
    } else if (enableRemoteFetch && entry.url?.trim()) {
      try {
        const fetched = await fetchAttachmentDataUrl(entry.url, entry.type);
        payload = {
          name: String(entry.name || 'attachment'),
          type: fetched.mimeType,
          size: fetched.size,
          dataUrl: fetched.dataUrl,
        };
      } catch (error) {
        console.warn('[whatsapp-webhook] attachment fetch skipped:', error);
      }
    }

    if (!payload) {
      continue;
    }
    attachments.push(
      persistIncomingAttachment({
        userId: `channel:whatsapp:${params.accountId}`,
        conversationId: params.scopedChatId,
        personaSlug: params.personaSlug || null,
        attachment: payload,
      }),
    );
  }
  return attachments;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as WhatsAppWebhookPayload;
    const accountId = resolveBridgeAccountIdFromRequest({
      request,
      bodyAccountId: payload.accountId,
    });

    // Verify webhook authenticity (account-scoped first, legacy fallback for default)
    const secret = resolveBridgeAccountSecret('whatsapp', accountId);
    if (!verifySharedSecret(request, secret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const envelope = normalizeWhatsAppInbound(payload);
    if (!envelope) {
      return NextResponse.json({ ok: true });
    }

    const allowFrom = resolveAllowFromValues(accountId);
    if (!isSenderAllowed(payload.from || envelope.externalChatId, allowFrom)) {
      return NextResponse.json({ ok: true });
    }

    const scopedChatId = scopeBridgeExternalChatId(accountId, envelope.externalChatId);
    const dedupeId =
      (envelope.externalMessageId || '').trim() || buildFallbackMessageId(payload, accountId);
    const service = getMessageService();
    let personaSlug: string | null = null;
    if (
      typeof (service as { getOrCreateConversation?: unknown }).getOrCreateConversation ===
      'function'
    ) {
      const conversation = service.getOrCreateConversation(ChannelType.WHATSAPP, scopedChatId);
      personaSlug = conversation.personaId
        ? getPersonaRepository().getPersona(conversation.personaId)?.slug || null
        : null;
    }
    const attachments = await resolveInboundAttachments({
      payload,
      accountId,
      scopedChatId,
      personaSlug,
    });
    await service.handleInbound(
      ChannelType.WHATSAPP,
      scopedChatId,
      envelope.content,
      envelope.senderName || 'WhatsApp User',
      envelope.externalMessageId || undefined,
      undefined,
      dedupeId,
      attachments.length > 0 ? attachments : undefined,
    );

    upsertBridgeAccount('whatsapp', {
      accountId,
      pairingStatus: 'connected',
      touchLastSeen: true,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}
