import { timingSafeEqual } from 'node:crypto';
import {
  appendHarnessRunEvents,
  createIngestReceipt,
  hasIngestReceipt,
  pruneHarnessRunEventsBefore,
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
const HARNESS_RETENTION_DAYS = 90;

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

function asOptionalString(value: unknown): string | null {
  const parsed = String(value || '').trim();
  return parsed ? parsed : null;
}

function redactRunUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = new URL(input);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 512);
  } catch {
    return null;
  }
}

function redactErrorKind(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  if (!normalized) return null;
  if (normalized.includes('token') || normalized.includes('secret') || normalized.includes('key')) {
    return 'redacted-sensitive-error';
  }
  return normalized;
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
    const windowDays = asInt(row.windowDays ?? row.window_days, 'windowDays');
    if (windowDays !== 7 && windowDays !== 30) {
      throw new Error('windowDays must be 7 or 30');
    }
    const source = String(row.source || 'github-snapshot').trim() || 'github-snapshot';
    const generatedAt = asIso(row.generatedAt ?? row.generated_at ?? new Date().toISOString());
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
      prNumber: asInt(row.prNumber ?? row.pr_number, 'prNumber'),
      createdAt: asIso(row.createdAt ?? row.created_at),
      mergedAt: asIso(row.mergedAt ?? row.merged_at),
      additions: asInt(row.additions || 0, 'additions'),
      deletions: asInt(row.deletions || 0, 'deletions'),
      firstPassBlocking: Boolean(row.firstPassBlocking ?? row.first_pass_blocking),
      reverted: Boolean(row.reverted),
    };
  });
}

function parseEvents(body: Record<string, unknown>): HarnessRunEvent[] {
  const raw = Array.isArray(body.events) ? body.events : [];
  return raw.map((entry) => {
    const row = asRecord(entry);
    if (!row) throw new Error('Invalid events payload');
    const statusInput = String(row.status || '')
      .trim()
      .toLowerCase();
    const status =
      statusInput === 'success'
        ? 'success'
        : statusInput === 'cancelled'
          ? 'cancelled'
          : statusInput === 'skipped'
            ? 'skipped'
            : 'failure';
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(status)) {
      throw new Error('Invalid event status');
    }
    const runUrlRaw = asOptionalString(row.runUrl ?? row.run_url);
    const errorKindRaw = asOptionalString(row.errorKind ?? row.error_kind);
    const commitSha = asOptionalString(row.commitSha ?? row.commit_sha);

    return {
      traceId: asOptionalString(row.traceId ?? row.trace_id),
      spanId: asOptionalString(row.spanId ?? row.span_id),
      serviceName:
        String((row.serviceName ?? row.service_name ?? '') as unknown).trim() || 'github-actions',
      domain: asOptionalString(row.domain),
      lane: String(row.lane || '').trim() || 'unknown',
      scenario: asOptionalString(row.scenario),
      status: status as HarnessRunEvent['status'],
      startedAt: asIso(row.startedAt ?? row.started_at),
      finishedAt: asIso(row.finishedAt ?? row.finished_at),
      durationMs: Math.max(0, asInt(row.durationMs ?? row.duration_ms ?? 0, 'durationMs')),
      worktreeId: asOptionalString(row.worktreeId ?? row.worktree_id),
      commitSha: commitSha && /^[a-f0-9]{7,40}$/i.test(commitSha) ? commitSha.toLowerCase() : null,
      errorKind: redactErrorKind(errorKindRaw),
      runUrl: redactRunUrl(runUrlRaw),
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
    const retentionCutoffIso = new Date(
      nowMs - HARNESS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const prunedEvents = pruneHarnessRunEventsBefore(retentionCutoffIso);

    return Response.json({
      ok: true,
      receivedAt,
      accepted: {
        snapshots: snapshots.length,
        prFacts: prFacts.length,
        events: events.length,
        prunedEvents,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to ingest engineering snapshots';
    const status = message.includes('Duplicate ingest idempotency key') ? 409 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
