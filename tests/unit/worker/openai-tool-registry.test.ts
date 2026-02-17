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
      'browserUse',
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
    const ids = [
      'shell',
      'browser',
      'browserUse',
      'files',
      'github',
      'mcp',
      'computerUse',
    ] as const;

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
            browserUse: { enabled: true },
            files: { enabled: true },
            github: { enabled: true },
            mcp: { enabled: false },
            computerUse: { enabled: true },
          },
        },
      },
    });

    expect(names).toEqual(['safe_shell', 'safe_browser_use', 'safe_files', 'safe_github']);
  });

  it('resolves approval policy with default mode and per-tool overrides', async () => {
    const registry = await import('../../../src/server/worker/openai/openaiToolRegistry');
    const policy = registry.resolveOpenAiWorkerToolApprovalPolicyFromConfig(
      {
        worker: {
          openai: {
            security: {
              defaultApprovalMode: 'ask_approve',
              tools: {
                shell: { approvalMode: 'deny' },
                browserUse: { approvalMode: 'approve_always' },
              },
            },
          },
        },
      },
      ['safe_shell', 'safe_browser_use', 'safe_files'],
    );

    expect(policy).toEqual({
      defaultMode: 'ask_approve',
      byFunctionName: {
        safe_shell: 'deny',
        safe_browser_use: 'approve_always',
        safe_files: 'ask_approve',
      },
    });
  });

  it('can update default approval mode and tool approval mode', async () => {
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
    const defaultMode = await registry.setOpenAiWorkerDefaultApprovalMode('approve_always');
    const browserMode = await registry.setOpenAiWorkerToolApprovalMode('browserUse', 'deny');

    expect(defaultMode).toBe('approve_always');
    expect(browserMode.approvalMode).toBe('deny');
    expect(saveGatewayConfig).toHaveBeenCalledTimes(2);
  });
});
