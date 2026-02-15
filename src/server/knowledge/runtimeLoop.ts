export interface KnowledgeRuntimeLoopOptions {
  enabled: boolean;
  intervalMs: number;
  runIngestion: () => Promise<unknown>;
}

export class KnowledgeRuntimeLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(private readonly options: KnowledgeRuntimeLoopOptions) {}

  start(): void {
    if (this.timer || !this.options.enabled) {
      return;
    }

    void this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.options.runIngestion();
    } catch (error) {
      console.warn('[knowledge] ingestion tick failed:', error);
    } finally {
      this.inFlight = false;
    }
  }
}
