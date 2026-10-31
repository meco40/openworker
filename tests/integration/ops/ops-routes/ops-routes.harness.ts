import { afterEach, beforeEach, vi } from 'vitest';
import type { MockProcedure } from '../../../helpers/mockProcedure';

type MockUserContext = { userId: string; authenticated: boolean } | null;

export function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn<MockProcedure>().mockResolvedValue(context),
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
