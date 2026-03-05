import { timingSafeEqual } from 'node:crypto';
import {
  appendHarnessRunEvents,
  createIngestReceipt,
  hasIngestReceipt,
  replaceEngineeringPrFacts,
  storeEngineeringSnapshot,
  type EngineeringPrFact,
  type HarnessRunEvent,
} from '@/server/stats/engineeringSnapshotRepository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 12;

declare global {
  var __engineeringIngestRateWindow: number[] | undefined;
}

function readBooleanEnv(name: string, fallback = false): boolean {
  const value = String(process.env[name] ?? '').trim();
  if (!value) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function isAuthorized(request: Request): boolean {
  const expectedToken = String(process.env.ENGINEERING_INGEST_TOKEN || '').trim();
  if (!expectedToken) return false;

  const providedToken = String(request.headers.get('x-engineering-ingest-token') || '').trim();
  if (!providedToken) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function isTimestampValid(request: Request, nowMs: number): boolean {
  const raw = String(request.headers.get('x-engineering-ingest-timestamp') || '').trim();
  if (!raw) return false;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(nowMs - parsed) <= MAX_CLOCK_SKEW_MS;
}

function consumeRateQuota(nowMs: number): boolean {
  const bucket = globalThis.__engineeringIngestRateWindow || [];
  const fresh = bucket.filter((value) => nowMs - value <= RATE_WINDOW_MS);
  if (fresh.length >= MAX_REQUESTS_PER_WINDOW) {
    globalThis.__engineeringIngestRateWindow = fresh;
    return false;
  }
  fresh.push(nowMs);
  globalThis.__engineeringIngestRateWindow = fresh;
  return true;
}

function readIdempotencyKey(request: Request): string {
  return String(request.headers.get('x-engineering-ingest-idempotency-key') || '')
    .trim()
    .slice(0, 128);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asIso(value: unknown): string {
  const parsed = String(value || '').trim();
  const asMs = Date.parse(parsed);
  if (!parsed || !Number.isFinite(asMs)) {
    throw new Error('Invalid ISO timestamp field');
  }
  return new Date(asMs).toISOString();
}

function asInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric field: ${field}`);
  }
  return Math.floor(parsed);
}

function parseSnapshotRows(body: Record<string, unknown>): Array<{
  windowDays: 7 | 30;
  source: string;
  generatedAt: string;
  payload: Record<string, unknown>;
}> {
  const raw = Array.isArray(body.snapshots) ? body.snapshots : [];
  return raw.map((entry) => {
    const row = asRecord(entry);
    if (!row) throw new Error('Invalid snapshots payload');
    const windowDays = asInt(row.windowDays, 'windowDays');
    if (windowDays !== 7 && windowDays !== 30) {
      throw new Error('windowDays must be 7 or 30');
    }
    const source = String(row.source || 'github-snapshot').trim() || 'github-snapshot';
    const generatedAt = asIso(row.generatedAt || new Date().toISOString());
    const payload = { ...row };
    return { windowDays: windowDays as 7 | 30, source, generatedAt, payload };
  });
}

function parsePrFacts(body: Record<string, unknown>): EngineeringPrFact[] {
  const raw = Array.isArray(body.prFacts) ? body.prFacts : [];
  return raw.map((entry) => {
    const row = asRecord(entry);
    if (!row) throw new Error('Invalid prFacts payload');
    return {
      prNumber: asInt(row.prNumber, 'prNumber'),
      createdAt: asIso(row.createdAt),
      mergedAt: asIso(row.mergedAt),
      additions: asInt(row.additions || 0, 'additions'),
      deletions: asInt(row.deletions || 0, 'deletions'),
      firstPassBlocking: Boolean(row.firstPassBlocking),
      reverted: Boolean(row.reverted),
    };
  });
}

function parseEvents(body: Record<string, unknown>): HarnessRunEvent[] {
  const raw = Array.isArray(body.events) ? body.events : [];
  return raw.map((entry) => {
    const row = asRecord(entry);
    if (!row) throw new Error('Invalid events payload');
    const status = String(row.status || '').trim();
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(status)) {
      throw new Error('Invalid event status');
    }
    return {
      traceId: row.traceId ? String(row.traceId) : null,
      spanId: row.spanId ? String(row.spanId) : null,
      serviceName: String(row.serviceName || '').trim() || 'github-actions',
      lane: String(row.lane || '').trim() || 'unknown',
      status: status as HarnessRunEvent['status'],
      startedAt: asIso(row.startedAt),
      finishedAt: asIso(row.finishedAt),
      durationMs: Math.max(0, asInt(row.durationMs || 0, 'durationMs')),
      errorKind: row.errorKind ? String(row.errorKind) : null,
      runUrl: row.runUrl ? String(row.runUrl) : null,
    };
  });
}

export async function POST(request: Request) {
  try {
    if (!readBooleanEnv('ENGINEERING_INGEST_ENABLED', false)) {
      return Response.json(
        { ok: false, error: 'Engineering ingest is disabled by feature flag.' },
        { status: 503 },
      );
    }

    if (!isAuthorized(request)) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const nowMs = Date.now();
    if (!isTimestampValid(request, nowMs)) {
      return Response.json(
        { ok: false, error: 'Ingest timestamp is missing or outside allowed clock skew.' },
        { status: 400 },
      );
    }

    if (!consumeRateQuota(nowMs)) {
      return Response.json(
        { ok: false, error: 'Rate limit exceeded for ingest window.' },
        { status: 429 },
      );
    }

    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) {
      return Response.json({ ok: false, error: 'Missing idempotency key.' }, { status: 400 });
    }
    if (hasIngestReceipt(idempotencyKey)) {
      return Response.json(
        { ok: false, error: 'Duplicate ingest idempotency key.' },
        { status: 409 },
      );
    }

    const rawBody = (await request.json()) as unknown;
    const body = asRecord(rawBody);
    if (!body) {
      return Response.json({ ok: false, error: 'Invalid ingest payload.' }, { status: 400 });
    }

    const snapshots = parseSnapshotRows(body);
    const prFacts = parsePrFacts(body);
    const events = parseEvents(body);
    const receivedAt = new Date(nowMs).toISOString();

    createIngestReceipt(idempotencyKey, receivedAt);
    for (const snapshot of snapshots) {
      storeEngineeringSnapshot(snapshot);
    }
    if (prFacts.length > 0) {
      replaceEngineeringPrFacts(prFacts);
    }
    if (events.length > 0) {
      appendHarnessRunEvents(events);
    }

    return Response.json({
      ok: true,
      receivedAt,
      accepted: {
        snapshots: snapshots.length,
        prFacts: prFacts.length,
        events: events.length,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to ingest engineering snapshots';
    const status = message.includes('Duplicate ingest idempotency key') ? 409 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
