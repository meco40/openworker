import { describe, expect, it } from 'vitest';

describe('app smoke', () => {
  it('has expected scripts', async () => {
    const pkg = await import('../../package.json');
    expect(pkg.default.scripts.dev).toBeDefined();
    expect(pkg.default.scripts.build).toBeDefined();
  });
});
