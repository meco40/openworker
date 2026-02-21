import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

function getRootTraceExcludes(): string[] {
  const excludes = nextConfig.outputFileTracingExcludes;
  if (!excludes) return [];
  return excludes['/*'] ?? [];
}

describe('next config output tracing excludes', () => {
  it('excludes local codex/openclaw home directories from standalone tracing', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('**/.codex/**');
    expect(rootExcludes).toContain('**/.openclaw/**');
    expect(rootExcludes).toContain('**/C:/Users/**/.codex/**');
    expect(rootExcludes).toContain('**/C:/Users/**/.openclaw/**');
  });

  it('excludes heavy local workspace artifacts from standalone tracing', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('.local/**');
    expect(rootExcludes).toContain('.local/**/*.db');
    expect(rootExcludes).toContain('tests/**');
    expect(rootExcludes).toContain('docs/**');
  });

  it('keeps canonical handlers exclude', () => {
    const rootExcludes = getRootTraceExcludes();

    expect(rootExcludes).toContain('src/server/skills/handlers/**');
  });
});
