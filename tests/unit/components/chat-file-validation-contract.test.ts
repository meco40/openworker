import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat file validation contract', () => {
  it('uses state-based validation flow instead of blocking alert()', () => {
    const filePath = path.resolve('src/modules/chat/hooks/useChatInterfaceState.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).not.toContain('alert(');
    expect(source).toContain('validationError');
    expect(source).toContain('setValidationError');
  });
});
