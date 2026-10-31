import type { Mock, vi } from 'vitest';

/**
 * vitest's default mock signature (its internal `Procedure`, which the package does not
 * export). Use it as `vi.fn<MockProcedure>()` for mocks whose signature the test leaves
 * open; prefer a concrete function type where the test relies on one.
 */
export type MockProcedure = Extract<
  ReturnType<typeof vi.fn> extends Mock<infer T> ? T : never,
  (...args: never[]) => unknown
>;
