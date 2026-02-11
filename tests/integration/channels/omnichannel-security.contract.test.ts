import { describe, expect, it } from 'vitest';

import { GET } from '../../../app/api/security/status/route';

describe('omnichannel security contract', () => {
  it('includes per-channel webhook verification diagnostics', async () => {
    const response = await GET();
    const json = (await response.json()) as {
      ok: boolean;
      channels?: Array<{ channel: string; verification: string; status: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.channels)).toBe(true);
    expect(json.channels?.some((entry) => entry.channel === 'telegram')).toBe(true);
    expect(json.channels?.some((entry) => entry.channel === 'slack')).toBe(true);
  });
});
