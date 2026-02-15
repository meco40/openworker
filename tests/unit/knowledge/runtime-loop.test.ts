import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeRuntimeLoop } from '../../../src/server/knowledge/runtimeLoop';

describe('KnowledgeRuntimeLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes ingestion periodically when enabled', async () => {
    vi.useFakeTimers();
    const runIngestion = vi.fn(async () => {});

    const loop = new KnowledgeRuntimeLoop({
      enabled: true,
      intervalMs: 1000,
      runIngestion,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(3200);

    expect(runIngestion).toHaveBeenCalledTimes(4);

    loop.stop();
  });

  it('does not run when disabled by feature flags', async () => {
    vi.useFakeTimers();
    const runIngestion = vi.fn(async () => {});

    const loop = new KnowledgeRuntimeLoop({
      enabled: false,
      intervalMs: 1000,
      runIngestion,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(runIngestion).not.toHaveBeenCalled();
  });

  it('supports graceful shutdown and prevents further ticks', async () => {
    vi.useFakeTimers();
    const runIngestion = vi.fn(async () => {});

    const loop = new KnowledgeRuntimeLoop({
      enabled: true,
      intervalMs: 1000,
      runIngestion,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(runIngestion).toHaveBeenCalledTimes(3);

    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(runIngestion).toHaveBeenCalledTimes(3);
  });
});
