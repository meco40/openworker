import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock localStorage for client-side tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get store() {
      return store;
    },
  };
})();

// Helper to reset modules and get fresh imports
async function getFreshConfigModule(mockWindow: boolean) {
  vi.resetModules();

  if (mockWindow) {
    // @ts-expect-error - mocking window for tests
    globalThis.window = {
      location: {
        origin: 'http://localhost:3000',
      },
    };
    // @ts-expect-error - mocking localStorage for tests
    globalThis.localStorage = localStorageMock;
  } else {
    // @ts-expect-error - intentionally removing window for server-side tests
    delete globalThis.window;
    // @ts-expect-error - intentionally removing localStorage for server-side tests
    delete globalThis.localStorage;
  }

  return import('@/lib/config');
}

describe('Config Management', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    // @ts-expect-error - cleanup
    delete globalThis.window;
    // @ts-expect-error - cleanup
    delete globalThis.localStorage;
  });

  describe('getConfig', () => {
    it('returns defaults on server side (no window)', async () => {
      const { getConfig } = await getFreshConfigModule(false);

      const config = getConfig();

      expect(config.workspaceBasePath).toBe('~/Documents/Shared');
      expect(config.projectsPath).toBe('~/Documents/Shared/projects');
      expect(config.defaultProjectName).toBe('mission-control');
    });

    it('returns defaults when localStorage is empty', async () => {
      const { getConfig } = await getFreshConfigModule(true);

      const config = getConfig();

      expect(config.workspaceBasePath).toBe('~/Documents/Shared');
      expect(config.projectsPath).toBe('~/Documents/Shared/projects');
    });

    it('merges stored config with defaults', async () => {
      localStorageMock.setItem(
        'mission-control-config',
        JSON.stringify({
          workspaceBasePath: '/custom/workspace',
          defaultProjectName: 'custom-project',
        }),
      );

      const { getConfig } = await getFreshConfigModule(true);

      const config = getConfig();

      expect(config.workspaceBasePath).toBe('/custom/workspace');
      expect(config.defaultProjectName).toBe('custom-project');
      // Falls back to default
      expect(config.projectsPath).toBe('~/Documents/Shared/projects');
    });

    it('handles corrupted localStorage data gracefully', async () => {
      localStorageMock.setItem('mission-control-config', 'not-valid-json');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { getConfig } = await getFreshConfigModule(true);

      const config = getConfig();

      // Should return defaults when parsing fails
      expect(config.workspaceBasePath).toBe('~/Documents/Shared');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('updateConfig', () => {
    it('throws on server side', async () => {
      const { updateConfig } = await getFreshConfigModule(false);

      expect(() => updateConfig({ workspaceBasePath: '/new/path' })).toThrow(
        'Cannot update config on server side',
      );
    });

    it('validates workspaceBasePath is not empty', async () => {
      const { updateConfig } = await getFreshConfigModule(true);

      expect(() => updateConfig({ workspaceBasePath: '' })).toThrow(
        'Workspace base path cannot be empty',
      );
      expect(() => updateConfig({ workspaceBasePath: '   ' })).toThrow(
        'Workspace base path cannot be empty',
      );
    });

    it('validates missionControlUrl is a valid URL', async () => {
      const { updateConfig } = await getFreshConfigModule(true);

      expect(() => updateConfig({ missionControlUrl: 'not-a-url' })).toThrow(
        'Invalid Mission Control URL',
      );
    });

    it('accepts valid URLs', async () => {
      const { updateConfig, getConfig } = await getFreshConfigModule(true);

      updateConfig({ missionControlUrl: 'https://api.example.com' });

      const config = getConfig();
      expect(config.missionControlUrl).toBe('https://api.example.com');
    });

    it('saves valid updates to localStorage', async () => {
      const { updateConfig, getConfig } = await getFreshConfigModule(true);

      updateConfig({
        workspaceBasePath: '/valid/path',
        defaultProjectName: 'test-project',
      });

      const stored = localStorageMock.getItem('mission-control-config');
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed.workspaceBasePath).toBe('/valid/path');
      expect(parsed.defaultProjectName).toBe('test-project');
    });
  });

  describe('resetConfig', () => {
    it('throws on server side', async () => {
      const { resetConfig } = await getFreshConfigModule(false);

      expect(() => resetConfig()).toThrow('Cannot reset config on server side');
    });

    it('removes config from localStorage', async () => {
      localStorageMock.setItem(
        'mission-control-config',
        JSON.stringify({ workspaceBasePath: '/stored' }),
      );

      const { resetConfig, getConfig } = await getFreshConfigModule(true);

      resetConfig();

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('mission-control-config');
      const config = getConfig();
      expect(config.workspaceBasePath).toBe('~/Documents/Shared');
    });
  });

  describe('getMissionControlUrl', () => {
    it('uses env var on server side', async () => {
      const originalEnv = process.env.MISSION_CONTROL_URL;
      process.env.MISSION_CONTROL_URL = 'https://env-server.example.com';

      const { getMissionControlUrl } = await getFreshConfigModule(false);

      const url = getMissionControlUrl();
      expect(url).toBe('https://env-server.example.com');

      process.env.MISSION_CONTROL_URL = originalEnv;
    });

    it('falls back to localhost with PORT on server side', async () => {
      const originalEnvUrl = process.env.MISSION_CONTROL_URL;
      const originalPort = process.env.PORT;
      delete process.env.MISSION_CONTROL_URL;
      process.env.PORT = '4000';

      const { getMissionControlUrl } = await getFreshConfigModule(false);

      const url = getMissionControlUrl();
      expect(url).toBe('http://localhost:4000');

      process.env.PORT = originalPort;
      if (originalEnvUrl) process.env.MISSION_CONTROL_URL = originalEnvUrl;
    });

    it('uses config on client side', async () => {
      localStorageMock.setItem(
        'mission-control-config',
        JSON.stringify({ missionControlUrl: 'https://client-config.example.com' }),
      );

      const { getMissionControlUrl } = await getFreshConfigModule(true);

      const url = getMissionControlUrl();
      expect(url).toBe('https://client-config.example.com');
    });
  });

  describe('getProjectsPath', () => {
    it('uses env var on server side', async () => {
      const originalEnv = process.env.PROJECTS_PATH;
      process.env.PROJECTS_PATH = '/env/projects';

      const { getProjectsPath } = await getFreshConfigModule(false);

      const path = getProjectsPath();
      expect(path).toBe('/env/projects');

      process.env.PROJECTS_PATH = originalEnv;
    });

    it('falls back to default on server side', async () => {
      const originalEnv = process.env.PROJECTS_PATH;
      delete process.env.PROJECTS_PATH;

      const { getProjectsPath } = await getFreshConfigModule(false);

      const path = getProjectsPath();
      expect(path).toBe('~/Documents/Shared/projects');

      if (originalEnv) process.env.PROJECTS_PATH = originalEnv;
    });

    it('uses config on client side', async () => {
      localStorageMock.setItem(
        'mission-control-config',
        JSON.stringify({ projectsPath: '/client/projects' }),
      );

      const { getProjectsPath } = await getFreshConfigModule(true);

      const path = getProjectsPath();
      expect(path).toBe('/client/projects');
    });
  });
});
