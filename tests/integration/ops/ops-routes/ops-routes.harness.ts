import { afterEach, beforeEach, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

export function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

export function registerOpsRouteLifecycleHooks(): void {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });
}
