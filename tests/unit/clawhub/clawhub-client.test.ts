import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installClawHubSkill,
  listInstalledClawHubSkills,
  searchClawHubSkills,
  setClawHubSkillEnabled,
  uninstallClawHubSkill,
} from '../../../skills/clawhub-client';

describe('clawhub-client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls search endpoint with query params', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          items: [{ slug: 'calendar', version: '1.0.0', title: 'Calendar', score: 0.5 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchClawHubSkills('calendar', 10);

    expect(fetchMock).toHaveBeenCalledWith('/api/clawhub/search?q=calendar&limit=10');
    expect(result.items).toHaveLength(1);
  });

  it('calls install endpoint with slug payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, skills: [{ slug: 'calendar', version: '1.0.0' }], warnings: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await installClawHubSkill({ slug: 'calendar' });

    expect(fetchMock).toHaveBeenCalledWith('/api/clawhub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'calendar' }),
    });
  });

  it('calls installed endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          skills: [{ slug: 'calendar', version: '1.0.0', title: 'Calendar', status: 'installed' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await listInstalledClawHubSkills();

    expect(fetchMock).toHaveBeenCalledWith('/api/clawhub/installed');
    expect(result.skills).toHaveLength(1);
  });

  it('calls enabled toggle endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          skill: {
            slug: 'calendar',
            version: '1.0.0',
            title: 'Calendar',
            status: 'installed',
            localPath: 'skills/calendar',
            enabled: true,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await setClawHubSkillEnabled('calendar', true);

    expect(fetchMock).toHaveBeenCalledWith('/api/clawhub/calendar', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('calls uninstall endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          skills: [],
          warnings: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await uninstallClawHubSkill('calendar');

    expect(fetchMock).toHaveBeenCalledWith('/api/clawhub/calendar', {
      method: 'DELETE',
    });
  });
});
