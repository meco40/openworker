import { describe, expect, it } from 'vitest';
import { GET } from '../../app/api/security/status/route';

describe('/api/security/status route', () => {
  it('returns computed security checks', async () => {
    const response = await GET();
    const json = (await response.json()) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
      summary: { ok: number; warning: number; critical: number };
      generatedAt: string;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.checks.length).toBeGreaterThan(0);
    expect(json.summary.ok + json.summary.warning + json.summary.critical).toBe(json.checks.length);
    expect(typeof json.generatedAt).toBe('string');
  });
});
