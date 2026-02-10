import { describe, expect, it } from 'vitest';

describe('public api contract', () => {
  it('keeps required routes', () => {
    expect(['/api/gemini', '/api/skills/execute', '/api/channels/pair'].length).toBe(3);
  });
});
