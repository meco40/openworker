class ClawHubError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status: number; code: string }) {
    super(message);
    this.name = 'ClawHubError';
    this.status = options.status;
    this.code = options.code;
  }
}

export class ClawHubInputError extends ClawHubError {
  constructor(message: string) {
    super(message, { status: 400, code: 'CLAW_INPUT_INVALID' });
  }
}

export class ClawHubNotFoundError extends ClawHubError {
  constructor(message: string) {
    super(message, { status: 404, code: 'CLAW_NOT_FOUND' });
  }
}

export function toClawHubHttpStatus(error: unknown, fallback = 500): number {
  if (error instanceof ClawHubError) {
    return error.status;
  }
  if (error && typeof error === 'object') {
    const typed = error as Record<string, unknown>;
    const status = typed.status;
    const code = typed.code;
    const name = typed.name;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      if (
        (typeof code === 'string' && code.startsWith('CLAW_')) ||
        name === 'ClawHubError' ||
        name === 'ClawHubInputError' ||
        name === 'ClawHubNotFoundError'
      ) {
        return status;
      }
    }
  }
  return fallback;
}

export function isValidClawHubSlug(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.trim());
}
