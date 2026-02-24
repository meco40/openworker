import { afterEach, describe, expect, it } from 'vitest';
import { resolveShellExecutionOptionsFromEnv } from '@/server/skills/handlers/shellExecute';

describe('shellExecute runtime configuration', () => {
  const previousTimeout = process.env.OPENCLAW_SHELL_TIMEOUT_MS;
  const previousMaxBuffer = process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES;

  afterEach(() => {
    if (previousTimeout === undefined) {
      delete process.env.OPENCLAW_SHELL_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_SHELL_TIMEOUT_MS = previousTimeout;
    }

    if (previousMaxBuffer === undefined) {
      delete process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES;
    } else {
      process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES = previousMaxBuffer;
    }
  });

  it('uses production-safe defaults when env values are missing', () => {
    delete process.env.OPENCLAW_SHELL_TIMEOUT_MS;
    delete process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES;

    const options = resolveShellExecutionOptionsFromEnv();
    expect(options.timeoutMs).toBe(600000);
    expect(options.maxBufferBytes).toBe(10000000);
  });

  it('clamps timeout and buffer env values to safety bounds', () => {
    process.env.OPENCLAW_SHELL_TIMEOUT_MS = '999999999';
    process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES = '999999999';
    const high = resolveShellExecutionOptionsFromEnv();
    expect(high.timeoutMs).toBe(7200000);
    expect(high.maxBufferBytes).toBe(100000000);

    process.env.OPENCLAW_SHELL_TIMEOUT_MS = '1';
    process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES = '10';
    const low = resolveShellExecutionOptionsFromEnv();
    expect(low.timeoutMs).toBe(5000);
    expect(low.maxBufferBytes).toBe(1000000);
  });
});
