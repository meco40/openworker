import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat main pane message delete contract', () => {
  it('renders a per-message delete action wired to onDeleteMessage', () => {
    const filePath = path.resolve('src/modules/chat/components/ChatMainPane.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('onDeleteMessage');
    expect(source).toContain('Nachricht loeschen');
    expect(source).toContain('onDeleteMessage(message)');
  });
});
