export const OPENAI_WORKER_EVENT_SCHEMA_VERSION = 1 as const;
export const OPENAI_WORKER_MIN_COMPAT_SCHEMA_VERSION = 0 as const;

export function isCompatibleSchemaVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= OPENAI_WORKER_MIN_COMPAT_SCHEMA_VERSION &&
    version <= OPENAI_WORKER_EVENT_SCHEMA_VERSION
  );
}

