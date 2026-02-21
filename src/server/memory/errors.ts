export class MemoryVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number, message = 'Memory version conflict. Reload and retry.') {
    super(message);
    this.name = 'MemoryVersionConflictError';
    this.currentVersion = currentVersion;
  }
}
