type Source = 'http' | 'ws';
type Action = 'upsert' | 'delete';

interface InboxObservabilityState {
  queryDurationsHttp: number[];
  queryDurationsWs: number[];
  eventEmitLatencyMs: number[];
  queriesHttp: number;
  queriesWs: number;
  eventsEmitted: number;
  eventsDropped: number;
  eventUpserts: number;
  eventDeletes: number;
  reconnectResyncCount: number;
}

declare global {
  var __inboxObservabilityState: InboxObservabilityState | undefined;
}

const MAX_DURATION_SAMPLES = 1_000;

function getState(): InboxObservabilityState {
  if (!globalThis.__inboxObservabilityState) {
    globalThis.__inboxObservabilityState = {
      queryDurationsHttp: [],
      queryDurationsWs: [],
      eventEmitLatencyMs: [],
      queriesHttp: 0,
      queriesWs: 0,
      eventsEmitted: 0,
      eventsDropped: 0,
      eventUpserts: 0,
      eventDeletes: 0,
      reconnectResyncCount: 0,
    };
  }
  return globalThis.__inboxObservabilityState;
}

function pushDuration(target: number[], value: number): void {
  target.push(value);
  if (target.length > MAX_DURATION_SAMPLES) {
    target.shift();
  }
}

function percentile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function recordInboxQueryDuration(source: Source, durationMs: number): void {
  const state = getState();
  const normalized = Math.max(0, Math.round(durationMs));
  if (source === 'http') {
    state.queriesHttp += 1;
    pushDuration(state.queryDurationsHttp, normalized);
  } else {
    state.queriesWs += 1;
    pushDuration(state.queryDurationsWs, normalized);
  }
}

export function recordInboxEventEmission(action: Action): void {
  const state = getState();
  state.eventsEmitted += 1;
  if (action === 'upsert') state.eventUpserts += 1;
  if (action === 'delete') state.eventDeletes += 1;
}

export function recordInboxEventLatency(durationMs: number): void {
  const state = getState();
  pushDuration(state.eventEmitLatencyMs, Math.max(0, Math.round(durationMs)));
}

export function recordInboxEventDropped(): void {
  const state = getState();
  state.eventsDropped += 1;
}

export function recordInboxReconnectResync(): void {
  const state = getState();
  state.reconnectResyncCount += 1;
}

export function getInboxObservabilitySnapshot(): {
  queries: { http: number; ws: number };
  queryLatencyMs: {
    httpP95: number | null;
    httpP99: number | null;
    wsP95: number | null;
    wsP99: number | null;
  };
  liveInsertLatencyMs: { p95: number | null; p99: number | null };
  events: {
    emitted: number;
    dropped: number;
    dropRate: number | null;
    upserts: number;
    deletes: number;
  };
  reconnectResyncCount: number;
} {
  const state = getState();
  return {
    queries: {
      http: state.queriesHttp,
      ws: state.queriesWs,
    },
    queryLatencyMs: {
      httpP95: percentile(state.queryDurationsHttp, 0.95),
      httpP99: percentile(state.queryDurationsHttp, 0.99),
      wsP95: percentile(state.queryDurationsWs, 0.95),
      wsP99: percentile(state.queryDurationsWs, 0.99),
    },
    liveInsertLatencyMs: {
      p95: percentile(state.eventEmitLatencyMs, 0.95),
      p99: percentile(state.eventEmitLatencyMs, 0.99),
    },
    events: {
      emitted: state.eventsEmitted,
      dropped: state.eventsDropped,
      dropRate:
        state.eventsEmitted + state.eventsDropped > 0
          ? state.eventsDropped / (state.eventsEmitted + state.eventsDropped)
          : null,
      upserts: state.eventUpserts,
      deletes: state.eventDeletes,
    },
    reconnectResyncCount: state.reconnectResyncCount,
  };
}

export function shouldLogInboxObservability(): boolean {
  return String(process.env.INBOX_V2_LOGS || '').toLowerCase() === 'true';
}

export function logInboxObservability(stage: string, payload: Record<string, unknown>): void {
  if (!shouldLogInboxObservability()) return;
  console.info(
    JSON.stringify({
      scope: 'inbox.v2',
      stage,
      ts: new Date().toISOString(),
      ...payload,
    }),
  );
}
