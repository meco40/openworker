import { afterEach, describe, expect, it, vi } from 'vitest';

describe('triggerAutomatedTaskTest', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is disabled by default in test environment', async () => {
    delete process.env.TASK_AUTOTEST_HTTP_TRIGGER;

    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;

    const autoTestingModule = await import('@/server/tasks/autoTesting');
    autoTestingModule.triggerAutomatedTaskTest('task-auto-disabled');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('can be explicitly enabled in test environment', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';

    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;

    const autoTestingModule = await import('@/server/tasks/autoTesting');
    autoTestingModule.triggerAutomatedTaskTest('task-auto-enabled');

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('logs missing tasks as debug instead of warn', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';

    const fetchSpy = vi.fn(async () => new Response('{"error":"Task not found"}', { status: 404 }));
    global.fetch = fetchSpy as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const autoTestingModule = await import('@/server/tasks/autoTesting');
    autoTestingModule.triggerAutomatedTaskTest('task-missing');

    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[auto-test] task task-missing skipped: task no longer exists'),
      );
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs local aborts as debug instead of error', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';

    const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const fetchSpy = vi.fn(async () => {
      throw error;
    });
    global.fetch = fetchSpy as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const autoTestingModule = await import('@/server/tasks/autoTesting');
    autoTestingModule.triggerAutomatedTaskTest('task-abort');

    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[auto-test] task task-abort skipped: request aborted'),
      );
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
