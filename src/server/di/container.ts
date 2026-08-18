/**
 * Central service container.
 *
 * Provides a lightweight dependency-injection surface on top of the existing
 * module-level getters. Services are registered as lazy factories and resolved
 * on first access. `reset()` clears all cached instances so tests can isolate
 * state between runs without relying on `globalThis` cleanup.
 *
 * This is intentionally additive: existing `getX()` module getters continue to
 * work unchanged, but new code and tests can use the container for explicit
 * dependency wiring and deterministic reset.
 */

type Factory<T> = () => T;

const factories = new Map<string, Factory<unknown>>();
const instances = new Map<string, unknown>();

export function registerService<T>(key: string, factory: Factory<T>): void {
  factories.set(key, factory as Factory<unknown>);
  instances.delete(key);
}

export function resolveService<T>(key: string): T {
  const cached = instances.get(key);
  if (cached !== undefined) {
    return cached as T;
  }
  const factory = factories.get(key);
  if (!factory) {
    throw new Error(`No service registered for key: ${key}`);
  }
  const instance = factory();
  instances.set(key, instance);
  return instance as T;
}

export function hasService(key: string): boolean {
  return factories.has(key);
}

export function resetContainer(): void {
  instances.clear();
}

export function clearContainer(): void {
  instances.clear();
  factories.clear();
}
