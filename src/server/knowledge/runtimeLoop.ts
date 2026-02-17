export interface KnowledgeRuntimeLoopOptions {
  enabled: boolean;
  intervalMs: number;
  runIngestion: () => Promise<unknown>;
  /** Optional: run cleanup of stale/placeholder facts after ingestion */
  runCleanup?: () => Promise<unknown>;
  /** Optional: run Mem0↔SQLite reconciliation */
  runReconciliation?: () => Promise<unknown>;
  /** Optional: run conversation summarization */
  runSummarization?: () => Promise<unknown>;
  /** How often to run maintenance tasks (cleanup/reconciliation/summarization). Default: every 10th tick. */
  maintenanceEveryNthTick?: number;
}

export class KnowledgeRuntimeLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private tickCount = 0;

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
    this.tickCount++;
    try {
      await this.options.runIngestion();

      // Run maintenance tasks periodically (not every tick)
      const maintenanceInterval = this.options.maintenanceEveryNthTick ?? 10;
      if (this.tickCount % maintenanceInterval === 0) {
        await this.runMaintenance();
      }
    } catch (error) {
      console.warn('[knowledge] ingestion tick failed:', error);
    } finally {
      this.inFlight = false;
    }
  }

  private async runMaintenance(): Promise<void> {
    if (this.options.runCleanup) {
      try {
        await this.options.runCleanup();
      } catch (error) {
        console.warn('[knowledge] cleanup failed:', error);
      }
    }

    if (this.options.runReconciliation) {
      try {
        await this.options.runReconciliation();
      } catch (error) {
        console.warn('[knowledge] reconciliation failed:', error);
      }
    }

    if (this.options.runSummarization) {
      try {
        await this.options.runSummarization();
      } catch (error) {
        console.warn('[knowledge] summarization failed:', error);
      }
    }
  }
}
