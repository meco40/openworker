import type { GatewayRequest } from '@/server/model-hub/Models/types';
import { buildCodexUserContentParts } from '../attachments/attachmentHandler';

export function buildCodexInputMessages(
  messages: GatewayRequest['messages'],
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  let assistantIndex = 0;
  const latestUserAttachmentIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if ((message.attachments?.length || 0) > 0) return index;
    }
    return -1;
  })();

  for (const [index, message] of messages.entries()) {
    const content = message.content.trim();
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const userContentParts = buildCodexUserContentParts(
        message,
        index === latestUserAttachmentIndex,
      );
      if (userContentParts.length === 0) continue;
      converted.push({
        role: 'user',
        content: userContentParts,
      });
      continue;
    }

    if (!content) continue;
    converted.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: `msg_${assistantIndex++}`,
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }

  return converted;
}
