import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { resolveRequestUserContextMock, getUserSettingsMock, saveUserSettingsMock } = vi.hoisted(
  () => ({
    resolveRequestUserContextMock: vi.fn(),
    getUserSettingsMock: vi.fn(),
    saveUserSettingsMock: vi.fn(),
  }),
);

vi.mock('../../../src/server/auth/userContext', () => ({
  resolveRequestUserContext: resolveRequestUserContextMock,
}));

vi.mock('../../../src/server/worker/workerRepository', () => ({
  getWorkerRepository: () => ({
    getUserSettings: getUserSettingsMock,
    saveUserSettings: saveUserSettingsMock,
  }),
}));

import { GET, PUT } from '../../../app/api/worker/settings/route';

const ABSOLUTE_ROOT =
  process.platform === 'win32' ? 'H:\\clawdbot\\workspace' : '/tmp/clawdbot-workspace';

describe('/api/worker/settings route', () => {
  beforeEach(() => {
    resolveRequestUserContextMock.mockReset();
    getUserSettingsMock.mockReset();
    saveUserSettingsMock.mockReset();
  });

  it('returns 401 without user context', async () => {
    resolveRequestUserContextMock.mockResolvedValue(null);

    const response = await GET();
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Unauthorized');
  });

  it('returns current settings for the authenticated user', async () => {
    resolveRequestUserContextMock.mockResolvedValue({
      userId: 'user-1',
      authenticated: true,
    });
    getUserSettingsMock.mockReturnValue({
      userId: 'user-1',
      defaultWorkspaceRoot: ABSOLUTE_ROOT,
      updatedAt: new Date().toISOString(),
    });

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      settings: {
        defaultWorkspaceRoot: string | null;
        currentWorkspaceRoot: string;
        workspaceRootSource: 'user_setting' | 'system_default';
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.settings.defaultWorkspaceRoot).toBe(ABSOLUTE_ROOT);
    expect(payload.settings.currentWorkspaceRoot).toBe(ABSOLUTE_ROOT);
    expect(payload.settings.workspaceRootSource).toBe('user_setting');
  });

  it('returns system default workspace root when no user setting exists', async () => {
    resolveRequestUserContextMock.mockResolvedValue({
      userId: 'user-1',
      authenticated: true,
    });
    getUserSettingsMock.mockReturnValue(null);

    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      settings: {
        defaultWorkspaceRoot: string | null;
        currentWorkspaceRoot: string;
        workspaceRootSource: 'user_setting' | 'system_default';
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.settings.defaultWorkspaceRoot).toBeNull();
    expect(payload.settings.currentWorkspaceRoot).toBe(path.join(process.cwd(), 'workspaces'));
    expect(payload.settings.workspaceRootSource).toBe('system_default');
  });

  it('rejects non-absolute paths on PUT', async () => {
    resolveRequestUserContextMock.mockResolvedValue({
      userId: 'user-1',
      authenticated: true,
    });

    const response = await PUT(
      new Request('http://localhost/api/worker/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspaceRoot: 'workspace/local' }),
      }),
    );
    const payload = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('absolute');
  });

  it('saves absolute path on PUT', async () => {
    resolveRequestUserContextMock.mockResolvedValue({
      userId: 'user-1',
      authenticated: true,
    });
    saveUserSettingsMock.mockReturnValue({
      userId: 'user-1',
      defaultWorkspaceRoot: ABSOLUTE_ROOT,
      updatedAt: new Date().toISOString(),
    });

    const response = await PUT(
      new Request('http://localhost/api/worker/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspaceRoot: ` ${ABSOLUTE_ROOT} ` }),
      }),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      settings: {
        defaultWorkspaceRoot: string | null;
        currentWorkspaceRoot: string;
        workspaceRootSource: 'user_setting' | 'system_default';
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(saveUserSettingsMock).toHaveBeenCalledWith('user-1', {
      defaultWorkspaceRoot: ABSOLUTE_ROOT,
    });
    expect(payload.settings.defaultWorkspaceRoot).toBe(ABSOLUTE_ROOT);
    expect(payload.settings.currentWorkspaceRoot).toBe(ABSOLUTE_ROOT);
    expect(payload.settings.workspaceRootSource).toBe('user_setting');
  });
});
