import type { GatewayRequest } from '@/server/model-hub/Models/types';
import { readStoredAttachmentAsDataUrl } from '@/server/channels/messages/attachments';
import {
  isImageAttachment,
  isTextAttachment,
  readTextAttachmentSnippet,
  attachmentFallbackText,
} from '../utils';
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '../constants';
import type { AttachmentItem, BuildMessageResult } from '../types';

function findLatestUserAttachmentIndex(messages: GatewayRequest['messages']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if ((message.attachments?.length || 0) > 0) return index;
  }
  return -1;
}

function buildContentParts(
  message: GatewayRequest['messages'][number],
  index: number,
  latestUserAttachmentIndex: number,
): Array<Record<string, unknown>> {
  const attachments = message.attachments || [];
  const contentParts: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];

  const trimmedContent = message.content.trim();
  if (trimmedContent) {
    textParts.push(trimmedContent);
  }

  for (const attachment of attachments) {
    const includeBinaryAttachment = index === latestUserAttachmentIndex;

    if (includeBinaryAttachment && isImageAttachment(attachment.mimeType)) {
      const dataUrl = readStoredAttachmentAsDataUrl(attachment as AttachmentItem);
      if (dataUrl) {
        if (textParts.length > 0) {
          contentParts.push({
            type: 'text',
            text: textParts.join('\n\n'),
          });
          textParts.length = 0;
        }
        contentParts.push({
          type: 'image_url',
          image_url: { url: dataUrl },
        });
        continue;
      }
    }

    if (includeBinaryAttachment && isTextAttachment(attachment.mimeType)) {
      const snippet = readTextAttachmentSnippet(attachment as AttachmentItem);
      if (snippet) {
        textParts.push(`Attachment ${attachment.name} (${attachment.mimeType}):\n${snippet}`);
        continue;
      }
    }

    textParts.push(attachmentFallbackText(attachment as AttachmentItem));
  }

  if (textParts.length > 0) {
    contentParts.push({
      type: 'text',
      text: textParts.join('\n\n'),
    });
  }

  return contentParts;
}

export function buildOpenAICompatibleMessages(
  messages: GatewayRequest['messages'],
): Array<BuildMessageResult> {
  const latestUserAttachmentIndex = findLatestUserAttachmentIndex(messages);

  return messages.map((message, index) => {
    const attachments = message.attachments || [];

    if (message.role !== 'user' || attachments.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    const contentParts = buildContentParts(message, index, latestUserAttachmentIndex);

    if (contentParts.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: contentParts,
    };
  });
}

export function buildRequestBody(
  request: GatewayRequest,
  providerId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildOpenAICompatibleMessages(request.messages),
    max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    stream: request.stream === true,
  };

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools;
  }

  if (request.reasoning_effort && (providerId === 'openai' || providerId === 'openai-codex')) {
    body.reasoning_effort = request.reasoning_effort;
  }

  return body;
}
