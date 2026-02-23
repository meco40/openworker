import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ci workflow e2e gates', () => {
  it('runs deterministic e2e smoke on pull requests', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('npm run test:e2e:smoke');
  });
});
