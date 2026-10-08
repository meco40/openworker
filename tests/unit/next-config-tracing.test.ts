import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

function getRootTraceExcludes(): string[] {
  const excludes = nextConfig.outputFileTracingExcludes;
  if (!excludes) return [];
  return excludes['/*'] ?? [];
}

describe('next config output tracing excludes', () => {
  it('allows loopback origins used by the custom development server', () => {
    expect(nextConfig.allowedDevOrigins).toEqual(['127.0.0.1', 'localhost']);
  });

  it('keeps runtime and generated artifacts out of the development watcher', () => {
    const webpack = nextConfig.webpack;
    expect(webpack).toBeTypeOf('function');

    const config = webpack?.({ watchOptions: {} } as never, { dev: true } as never) as {
      watchOptions?: { ignored?: unknown };
    };

    expect(config.watchOptions?.ignored).toEqual([
      '**/.local/**',
      '**/.playwright-cli/**',
      '**/coverage/**',
      '**/output/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ]);
  });

  it('excludes local codex/openclaw home directories from standalone tracing', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('**/.codex/**');
    expect(rootExcludes).toContain('**/.openclaw/**');
  });

  it('excludes heavy local workspace artifacts from standalone tracing', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('.local/**');
    expect(rootExcludes).toContain('.local/**/*.db');
    expect(rootExcludes).toContain('coverage/**');
    expect(rootExcludes).toContain('playwright-report/**');
    expect(rootExcludes).toContain('test-results/**');
    expect(rootExcludes).toContain('dist/**');
    expect(rootExcludes).toContain('tests/**');
    expect(rootExcludes).toContain('docs/**');
  });

  it('keeps canonical handlers exclude', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('src/server/skills/handlers/**');
  });
});
