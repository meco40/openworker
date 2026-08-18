import { afterEach, describe, expect, it } from 'vitest';
import {
  clearContainer,
  hasService,
  registerService,
  resetContainer,
  resolveService,
} from '@/server/di/container';

describe('di/container', () => {
  afterEach(() => {
    clearContainer();
  });

  it('resolves a registered service lazily', () => {
    let factoryCalls = 0;
    registerService('test.service', () => {
      factoryCalls += 1;
      return { value: 42 };
    });

    const first = resolveService<{ value: number }>('test.service');
    const second = resolveService<{ value: number }>('test.service');

    expect(first).toBe(second);
    expect(first.value).toBe(42);
    expect(factoryCalls).toBe(1);
  });

  it('throws when resolving an unregistered service', () => {
    expect(() => resolveService('missing.service')).toThrow(
      'No service registered for key: missing.service',
    );
  });

  it('hasService returns true only for registered services', () => {
    expect(hasService('test.service')).toBe(false);
    registerService('test.service', () => ({ value: 1 }));
    expect(hasService('test.service')).toBe(true);
  });

  it('resetContainer clears cached instances but keeps factories', () => {
    let factoryCalls = 0;
    registerService('test.service', () => {
      factoryCalls += 1;
      return { value: factoryCalls };
    });

    const first = resolveService<{ value: number }>('test.service');
    expect(first.value).toBe(1);

    resetContainer();

    const second = resolveService<{ value: number }>('test.service');
    expect(second.value).toBe(2);
    expect(second).not.toBe(first);
  });

  it('clearContainer removes factories and instances', () => {
    registerService('test.service', () => ({ value: 1 }));
    resolveService('test.service');

    clearContainer();

    expect(hasService('test.service')).toBe(false);
    expect(() => resolveService('test.service')).toThrow();
  });

  it('registerService replaces an existing factory', () => {
    registerService('test.service', () => ({ value: 1 }));
    const first = resolveService<{ value: number }>('test.service');
    expect(first.value).toBe(1);

    registerService('test.service', () => ({ value: 2 }));
    const second = resolveService<{ value: number }>('test.service');
    expect(second.value).toBe(2);
    expect(second).not.toBe(first);
  });
});
