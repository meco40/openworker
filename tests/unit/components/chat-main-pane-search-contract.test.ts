import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat main pane conversation search contract', () => {
  it('provides in-conversation search input and next/prev result navigation controls', () => {
    const filePath = path.resolve('src/modules/chat/components/ChatMainPane.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('In Konversation suchen');
    expect(source).toContain('onClick={handleFindPrevious}');
    expect(source).toContain('onClick={handleFindNext}');
    expect(source).toContain('stepConversationSearchIndex');
    expect(source).toContain('search-highlight-active');
  });
});
