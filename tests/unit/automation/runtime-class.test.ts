import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationRuntime } from '@/server/automation/runtime';

interface RuntimeServiceStub {
  acquireLease: ReturnType<typeof vi.fn>;
  processTick: ReturnType<typeof vi.fn>;
  releaseLease: ReturnType<typeof vi.fn>;
}

function createRuntimeServiceStub(overrides: Partial<RuntimeServiceStub> = {}): RuntimeServiceStub {
  return {
    acquireLease: vi.fn(() => true),
    processTick: vi.fn(async () => {}),
    releaseLease: vi.fn(),
    ...overrides,
  };
}

describe('AutomationRuntime class', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when scheduler lease is not acquired', async () => {
    const service = createRuntimeServiceStub({
      acquireLease: vi.fn(() => false),
    });
    const runtime = new AutomationRuntime(service as never, { instanceId: 'scheduler-1' });

    await runtime.runOnce();

    expect(service.acquireLease).toHaveBeenCalledWith('scheduler-1', 30_000, expect.any(String));
    expect(service.processTick).not.toHaveBeenCalled();
  });

  it('logs errors when processTick fails and keeps runtime alive', async () => {
    const service = createRuntimeServiceStub({
      acquireLease: vi.fn(() => true),
      processTick: vi.fn(async () => {
        throw new Error('tick failed');
      }),
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = new AutomationRuntime(service as never, { instanceId: 'scheduler-1' });

    await runtime.runOnce();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[automation] runtime tick failed:',
      expect.any(Error),
    );
  });

  it('starts once, schedules interval with unref, and stops cleanly', () => {
    const service = createRuntimeServiceStub({
      acquireLease: vi.fn(() => false),
    });
    const runtime = new AutomationRuntime(service as never, {
      instanceId: 'scheduler-1',
      tickIntervalMs: 1234,
    });

    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const runOnceSpy = vi.spyOn(runtime, 'runOnce').mockResolvedValue();

    runtime.stop();
    expect(service.releaseLease).toHaveBeenCalledTimes(1);

    runtime.start();
    runtime.start();

    expect(runOnceSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(unref).toHaveBeenCalledTimes(1);

    runtime.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    expect(service.releaseLease).toHaveBeenCalledTimes(2);
  });
});
