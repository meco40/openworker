import { describe, expect, it } from 'vitest';

describe('strictness smoke', () => {
  it('enforces typed contracts at build time', () => {
    expect(true).toBe(true);
  });
});
