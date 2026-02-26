import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);

describe('gateway config rollback safety', () => {
  it('cleans temp file when rename fails and keeps previous file', async () => {
    process.env.OPENCLAW_CONFIG_PATH = '.local/gateway-rollback-test.json';
    process.env.OPENCLAW_CONFIG_BACKEND = 'file';
    const expectedPath = path.resolve(process.cwd(), '.local/gateway-rollback-test.json');
    let configReadCount = 0;

    fsMock.mkdir.mockImplementation(async () => {});
    fsMock.readFile.mockImplementation(async (targetPath: string) => {
      if (targetPath !== expectedPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      configReadCount += 1;
      if (configReadCount <= 2) {
        return JSON.stringify({ gateway: { port: 8080, host: '127.0.0.1', logLevel: 'info' } });
      }
      return 'existing-config-raw';
    });
    fsMock.writeFile.mockImplementation(async () => {});
    fsMock.rename.mockRejectedValueOnce(new Error('rename failed'));
    fsMock.rm.mockImplementation(async () => {});

    const { loadGatewayConfig, saveGatewayConfig } =
      await import('@/server/config/gateway/gatewayConfig');
    const loaded = await loadGatewayConfig();

    await expect(
      saveGatewayConfig(
        { gateway: { port: 8081, host: '127.0.0.1', logLevel: 'info' } },
        { expectedRevision: loaded.revision },
      ),
    ).rejects.toThrow('rename failed');

    expect(fsMock.rm).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFile.mock.calls.some((args) => String(args[0]).endsWith('.bak'))).toBe(true);

    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_CONFIG_BACKEND;
  });
});
