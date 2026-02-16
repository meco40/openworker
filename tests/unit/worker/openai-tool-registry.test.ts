import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('openaiToolRegistry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('lists all worker tools with default disabled state', async () => {
    vi.doMock('../../../src/server/config/gatewayConfig', () => ({
      loadGatewayConfig: vi.fn().mockResolvedValue({
        config: {},
        revision: 'rev-1',
      }),
      saveGatewayConfig: vi.fn(),
    }));

    const registry = await import('../../../src/server/worker/openai/openaiToolRegistry');
    const tools = await registry.listOpenAiWorkerTools();

    expect(tools.map((tool) => tool.id)).toEqual([
      'shell',
      'browser',
      'files',
      'github',
      'mcp',
      'computerUse',
    ]);
    expect(tools.every((tool) => tool.enabled === false)).toBe(true);
  });

  it('can enable and disable each tool via config updates', async () => {
    let currentConfig: Record<string, unknown> = {};
    const saveGatewayConfig = vi.fn(async (nextConfig: unknown) => {
      currentConfig = nextConfig as Record<string, unknown>;
      return { config: currentConfig, revision: 'rev-2' };
    });
    const loadGatewayConfig = vi.fn(async () => ({
      config: currentConfig,
      revision: 'rev-1',
    }));
    vi.doMock('../../../src/server/config/gatewayConfig', () => ({
      loadGatewayConfig,
      saveGatewayConfig,
    }));

    const registry = await import('../../../src/server/worker/openai/openaiToolRegistry');
    const ids = ['shell', 'browser', 'files', 'github', 'mcp', 'computerUse'] as const;

    for (const id of ids) {
      const enabled = await registry.setOpenAiWorkerToolEnabled(id, true);
      expect(enabled.enabled).toBe(true);
      const disabled = await registry.setOpenAiWorkerToolEnabled(id, false);
      expect(disabled.enabled).toBe(false);
    }

    expect(saveGatewayConfig).toHaveBeenCalledTimes(ids.length * 2);
    expect(loadGatewayConfig).toHaveBeenCalled();
  });

  it('resolves enabled function names from config', async () => {
    const registry = await import('../../../src/server/worker/openai/openaiToolRegistry');
    const names = registry.resolveEnabledOpenAiWorkerToolNamesFromConfig({
      worker: {
        openai: {
          tools: {
            shell: { enabled: true },
            browser: { enabled: false },
            files: { enabled: true },
            github: { enabled: true },
            mcp: { enabled: false },
            computerUse: { enabled: true },
          },
        },
      },
    });

    expect(names).toEqual(['safe_shell', 'safe_files', 'safe_github', 'safe_computer_use']);
  });
});
