import { REDACTED_SECRET_VALUE, SECRET_PATHS } from './constants';
import { cloneObject } from './normalize';
import type { GatewayConfig, JsonObject } from './types';

function getPathValue(root: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
}

function setPathValue(root: unknown, segments: readonly string[], value: unknown): void {
  let cursor = root as JsonObject;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const current = cursor[segment];
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonObject;
  }
  cursor[segments[segments.length - 1]] = value;
}

export function redactGatewayConfigSecrets(config: GatewayConfig): GatewayConfig {
  const redacted = cloneObject(config);
  for (const pathSegments of SECRET_PATHS) {
    const value = getPathValue(redacted, pathSegments);
    if (typeof value === 'string' && value.trim().length > 0) {
      setPathValue(redacted, pathSegments, REDACTED_SECRET_VALUE);
    }
  }
  return redacted;
}

export function restoreRedactedSecrets(nextConfig: unknown, currentConfig: GatewayConfig): unknown {
  const restored = cloneObject(nextConfig);
  for (const pathSegments of SECRET_PATHS) {
    const nextValue = getPathValue(restored, pathSegments);
    if (nextValue !== REDACTED_SECRET_VALUE) continue;
    const currentValue = getPathValue(currentConfig, pathSegments);
    if (typeof currentValue === 'string' && currentValue.trim().length > 0) {
      setPathValue(restored, pathSegments, currentValue);
    }
  }
  return restored;
}
