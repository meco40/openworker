import { describe, expect, it } from 'vitest';
import { GET } from '../../../app/api/model-hub/providers/route';

describe('model-hub providers route', () => {
  it('returns provider metadata', async () => {
    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(Array.isArray(json.providers)).toBe(true);
    expect(json.providers.length).toBeGreaterThan(0);
  });
});
