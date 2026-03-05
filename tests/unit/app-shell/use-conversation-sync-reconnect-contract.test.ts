import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useConversationSync reconnect contract', () => {
  it('reloads conversations and active history when gateway reconnects', () => {
    const filePath = path.resolve('src/modules/app-shell/useConversationSync.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('client.onStateChange');
    expect(source).toContain("if (state !== 'connected')");
    expect(source).toContain('void loadConversations({ resync: true })');
    expect(source).toContain('/api/channels/inbox?');
    expect(source).toContain("params.set('resync', '1')");
    expect(source).toContain('void loadMessages(currentConversationId)');
  });
});
