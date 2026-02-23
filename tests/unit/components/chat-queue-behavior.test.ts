import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat queue behavior contract', () => {
  it('uses an outbound queue and does not block send with isGenerating guard', () => {
    const filePath = path.resolve('src/modules/chat/hooks/useChatInterfaceState.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('sendQueueRef');
    expect(source).toContain('processQueue');
    expect(source).toContain('removeQueuedMessage');
    expect(source).toContain('entry.id !== queueId');
    expect(source).toContain('conversationId: activeConversation.id');
    expect(source).toContain('personaId: activeConversation.personaId ?? activePersonaId ?? null');
    expect(source).toContain('next.personaId || undefined');
    expect(source).not.toContain('|| !activeConversation || isGenerating');
  });
});
