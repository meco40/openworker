export interface WorldModelMetricsInput {
  pendingObservations: number;
  outboxAgeMs: number;
  outboxDeadLetters: number;
  dueOpenLoops: number;
  projectionLagMs: number;
}

export interface WorldModelMetrics {
  ingestionLagMs: number;
  pendingObservations: number;
  projectionLagMs: number;
  outboxAgeMs: number;
  outboxDeadLetters: number;
  dueOpenLoops: number;
  mode: string;
}

/**
 * Phase 15: Stellt beobachtbare World-Model-Metriken zusammen. Reine
 * Aggregation der Eingabewerte + Rollout-Modus, damit die Control-Plane-Route
 * nur noch die Werte sammelt.
 */
export function summarizeWorldModelMetrics(
  input: WorldModelMetricsInput,
  mode: string,
): WorldModelMetrics {
  return {
    ingestionLagMs: Math.max(0, input.projectionLagMs),
    pendingObservations: Math.max(0, input.pendingObservations),
    projectionLagMs: Math.max(0, input.projectionLagMs),
    outboxAgeMs: Math.max(0, input.outboxAgeMs),
    outboxDeadLetters: Math.max(0, input.outboxDeadLetters),
    dueOpenLoops: Math.max(0, input.dueOpenLoops),
    mode,
  };
}

export function worldModelHealthStatus(metrics: WorldModelMetrics): 'healthy' | 'degraded' {
  const degraded =
    metrics.outboxDeadLetters > 0 ||
    metrics.outboxAgeMs > 5 * 60_000 ||
    metrics.pendingObservations > 50;
  return degraded ? 'degraded' : 'healthy';
}
