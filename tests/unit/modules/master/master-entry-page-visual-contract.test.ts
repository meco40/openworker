import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MasterEntryPage visual contract', () => {
  function loadSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/components/MasterEntryPage.tsx'),
      'utf8',
    );
  }

  it('does not wrap the hologram in a bordered box container', () => {
    const source = loadSource();
    expect(source).not.toContain('rounded-[28px]');
    expect(source).not.toContain('border-cyan-400/18');
    expect(source).not.toContain('p-3 shadow-[0_0_34px');
  });
});
