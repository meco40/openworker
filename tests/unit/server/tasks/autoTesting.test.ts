import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('parseBooleanEnv (via isAutoTestHttpTriggerEnabled)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('treats "false" as disabled (parseBooleanEnv false branch)', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'false';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-false');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats "0" as disabled', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = '0';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-zero');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats "off" as disabled', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'off';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-off');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats "on" as enabled (parseBooleanEnv true branch)', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'on';
    process.env.PORT = '3000';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-on');
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('treats "yes" as enabled', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'yes';
    process.env.PORT = '3000';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-yes');
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('treats unknown value as null → falls back to NODE_ENV check', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'maybe';
    vi.stubEnv('NODE_ENV', 'test'); // disabled in test env
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-bool-unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('isExpectedAbort — error code variants', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('treats ECONNABORTED as expected abort', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    const error = Object.assign(new Error('connection aborted'), { code: 'ECONNABORTED' });
    global.fetch = vi.fn(async () => {
      throw error;
    }) as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-econnaborted');
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('skipped: request aborted'));
    });
  });

  it('treats ABORT_ERR as expected abort', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    global.fetch = vi.fn(async () => {
      throw error;
    }) as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-abort-err');
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('skipped: request aborted'));
    });
  });

  it('treats "socket hang up" message as expected abort', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    const error = new Error('socket hang up');
    global.fetch = vi.fn(async () => {
      throw error;
    }) as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-socket-hang-up');
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('skipped: request aborted'));
    });
  });

  it('treats non-abort errors as real errors', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    const error = new Error('network failure');
    global.fetch = vi.fn(async () => {
      throw error;
    }) as typeof fetch;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-real-error');
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[auto-test] failed for task task-real-error:'),
        error,
      );
    });
  });

  it('treats error with non-object value as non-abort', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    global.fetch = vi.fn(async () => {
      throw 'string-error';
    }) as typeof fetch;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-string-throw');
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  it('treats error with cause.code as expected abort', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';
    const error = new Error('fetch failed', { cause: { code: 'ABORT_ERR' } });
    global.fetch = vi.fn(async () => {
      throw error;
    }) as typeof fetch;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-cause-code');
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('skipped: request aborted'));
    });
  });
});

describe('triggerAutomatedTaskTest — in-flight dedup', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('skips duplicate trigger for same taskId while in-flight', async () => {
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
    process.env.PORT = '3000';

    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let fetchCallCount = 0;

    global.fetch = vi.fn(async () => {
      fetchCallCount += 1;
      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const m = await import('@/server/tasks/autoTesting');
    m.triggerAutomatedTaskTest('task-inflight');
    await firstStarted;
    m.triggerAutomatedTaskTest('task-inflight'); // second call — should be deduped

    await vi.waitFor(
      () => {
        expect(fetchCallCount).toBe(1);
      },
      { timeout: 500 },
    );
  });
});

describe('discoverHtmlFiles — MAX_DISCOVERED_HTML_FILES limit', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('stops discovering HTML files after reaching the 20-file limit', async () => {
    // Create temp dir with 25 html files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-html-limit-'));
    try {
      for (let i = 0; i < 25; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.html`), '<html></html>');
      }

      // Can't directly call discoverHtmlFiles (private), but we can test via
      // ensureTaskDeliverablesFromProjectDir which calls it internally.
      // We need to mock DB calls.
      vi.doMock('@/lib/db', () => ({
        queryAll: vi.fn(() => []),
        run: vi.fn(),
      }));
      vi.doMock('@/lib/config', () => ({
        getMissionControlUrl: vi.fn(() => 'http://localhost:3000'),
        getProjectsPath: vi.fn(() => tmpDir),
      }));

      const m = await import('@/server/tasks/autoTesting');
      const result = m.ensureTaskDeliverablesFromProjectDir({
        taskId: 'task-html-limit',
        taskTitle: '', // empty title → uses taskId as slug
        projectDir: tmpDir,
      });

      // Should cap at 20
      expect(result.added).toBe(20);
      expect(result.total).toBe(20);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
