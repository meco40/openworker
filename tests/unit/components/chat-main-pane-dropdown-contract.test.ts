import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat main pane persona dropdown contract', () => {
  it('closes persona dropdown on outside click', () => {
    const filePath = path.resolve('src/modules/chat/components/ChatMainPane.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('showPersonaDropdown');
    expect(source).toContain("document.addEventListener('mousedown'");
    expect(source).toContain('dropdownRef.current?.contains');
    expect(source).toContain('setShowPersonaDropdown(false)');
  });
});
