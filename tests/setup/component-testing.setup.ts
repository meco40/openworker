import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type { MockProcedure } from '../helpers/mockProcedure';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Next.js Image Mock
vi.mock('next/image', () => ({
  default: vi.fn<MockProcedure>().mockImplementation((props: Record<string, unknown>) => {
    const { src, alt, width, height, ...rest } = props;
    return React.createElement('img', {
      src: typeof src === 'string' ? src : '',
      alt: alt ?? '',
      width: width ?? undefined,
      height: height ?? undefined,
      ...rest,
    });
  }),
}));

// Next.js Navigation Mock
const mockPush = vi.fn<MockProcedure>();
const mockReplace = vi.fn<MockProcedure>();
const mockBack = vi.fn<MockProcedure>();
const mockForward = vi.fn<MockProcedure>();
const mockRefresh = vi.fn<MockProcedure>();
const mockPrefetch = vi.fn<MockProcedure>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: mockBack,
    forward: mockForward,
    refresh: mockRefresh,
    prefetch: mockPrefetch,
    pathname: '/',
    query: {},
    asPath: '/',
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// ResizeObserver Mock (for UI components)
global.ResizeObserver = vi.fn<MockProcedure>().mockImplementation(() => ({
  observe: vi.fn<MockProcedure>(),
  unobserve: vi.fn<MockProcedure>(),
  disconnect: vi.fn<MockProcedure>(),
}));

// IntersectionObserver Mock
global.IntersectionObserver = vi.fn<MockProcedure>().mockImplementation(() => ({
  observe: vi.fn<MockProcedure>(),
  unobserve: vi.fn<MockProcedure>(),
  disconnect: vi.fn<MockProcedure>(),
}));

// MatchMedia Mock (for responsive components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn<MockProcedure>().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn<MockProcedure>(),
    removeListener: vi.fn<MockProcedure>(),
    addEventListener: vi.fn<MockProcedure>(),
    removeEventListener: vi.fn<MockProcedure>(),
    dispatchEvent: vi.fn<MockProcedure>(),
  })),
});

// ScrollTo Mock
window.scrollTo = vi.fn<MockProcedure>();

// Export mocks for use in tests
export const routerMocks = {
  push: mockPush,
  replace: mockReplace,
  back: mockBack,
  forward: mockForward,
  refresh: mockRefresh,
  prefetch: mockPrefetch,
};
