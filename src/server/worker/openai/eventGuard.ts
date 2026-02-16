import type { OpenAiWorkerApplyResult, OpenAiWorkerEventEnvelope } from './types';
import { isCompatibleSchemaVersion } from './eventSchemaVersion';

interface RunState {
  seenEventIds: Set<string>;
  lastSeq: number;
}

/**
 * In-memory guard used before mutating worker state from sidecar callbacks.
 * This is intentionally small and deterministic for testability.
 */
export class OpenAiWorkerEventGuard {
  private readonly runStates = new Map<string, RunState>();

  apply(event: OpenAiWorkerEventEnvelope): OpenAiWorkerApplyResult {
    if (!isCompatibleSchemaVersion(event.schemaVersion)) {
      return 'rejected_out_of_order';
    }

    const state = this.getRunState(event.runId);
    if (state.seenEventIds.has(event.eventId)) {
      return 'duplicate';
    }
    if (event.seq <= state.lastSeq) {
      return 'rejected_out_of_order';
    }

    state.seenEventIds.add(event.eventId);
    state.lastSeq = event.seq;
    return 'applied';
  }

  getLastSeq(runId: string): number {
    return this.getRunState(runId).lastSeq;
  }

  reset(runId: string): void {
    this.runStates.delete(runId);
  }

  private getRunState(runId: string): RunState {
    const existing = this.runStates.get(runId);
    if (existing) return existing;
    const created: RunState = { seenEventIds: new Set(), lastSeq: 0 };
    this.runStates.set(runId, created);
    return created;
  }
}

