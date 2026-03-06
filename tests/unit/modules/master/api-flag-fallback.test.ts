import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('master api flag fallbacks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty approval list when the approvals route is disabled', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'disabled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { fetchApprovalRequests } = await import('@/modules/master/api');

    await expect(fetchApprovalRequests('main', 'master-1')).resolves.toEqual([]);
  });

  it('returns an empty subagent session list when the session route is disabled', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'disabled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { fetchSubagentSessions } = await import('@/modules/master/api');

    await expect(fetchSubagentSessions('main', 'master-1')).resolves.toEqual([]);
  });
});
