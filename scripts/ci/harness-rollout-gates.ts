import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateHarnessRollout,
  isGoNoGoDate,
  loadHarnessRolloutConfig,
  type RolloutBaselineRecord,
} from '@/server/stats/harnessRollout';

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function loadInputSnapshot(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error('Snapshot input must be an object payload.');
  }
  return record;
}

function readSnapshotsByWindow(
  payload: Record<string, unknown>,
): Partial<Record<7 | 30, Record<string, unknown>>> {
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  const map: Partial<Record<7 | 30, Record<string, unknown>>> = {};
  for (const entry of snapshots) {
    const row = asRecord(entry);
    if (!row) continue;
    const windowDays = Number(row.windowDays ?? row.window_days);
    if (windowDays !== 7 && windowDays !== 30) continue;
    map[windowDays as 7 | 30] = row;
  }
  return map;
}

function readBaseline(
  payload: Record<string, unknown>,
  generatedAt: string,
): RolloutBaselineRecord | null {
  const row = asRecord(payload.rolloutBaseline ?? payload.rollout_baseline);
  if (!row) return null;
  const baselinePayload = asRecord(row.payload);
  if (!baselinePayload) return null;
  const id = String(row.id || '').trim();
  const source = String(row.source || 'github-snapshot').trim() || 'github-snapshot';
  const hash = String(row.hash || row.baseline_hash || '').trim();
  if (!id || !hash) return null;
  return {
    id,
    payload: baselinePayload,
    createdAt: generatedAt,
    source,
    hash,
  };
}

function readMeta(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.meta) || {};
}

function main(): void {
  const inputPath =
    String(
      process.env.ROLL_OUT_SNAPSHOT_INPUT || process.env.ENGINEERING_SNAPSHOT_OUTPUT || '',
    ).trim() || path.resolve(process.cwd(), 'engineering-metrics-snapshot.json');
  const outputPath =
    String(process.env.ROLL_OUT_GATE_OUTPUT || '').trim() ||
    path.resolve(process.cwd(), 'harness-rollout-gates-report.json');
  const now = process.env.ROLLOUT_NOW_ISO
    ? new Date(String(process.env.ROLLOUT_NOW_ISO))
    : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('ROLLOUT_NOW_ISO is invalid.');
  }

  const enforce = readBooleanEnv('ROLLOUT_GATES_ENFORCE', false);
  const payload = loadInputSnapshot(inputPath);
  const snapshotsByWindow = readSnapshotsByWindow(payload);
  const generatedAt = new Date().toISOString();
  const baseline = readBaseline(payload, generatedAt);
  const meta = readMeta(payload);
  for (const windowDays of [7, 30] as const) {
    const snapshot = snapshotsByWindow[windowDays];
    if (!snapshot) continue;
    snapshotsByWindow[windowDays] = {
      ...snapshot,
      meta,
    };
  }

  const config = loadHarnessRolloutConfig();

  const rollout = evaluateHarnessRollout({
    config,
    snapshotsByWindow,
    baseline,
    now,
  });

  const output = {
    ok: rollout.overallStatus === 'pass',
    enforce,
    generatedAt,
    goNoGoDate: isGoNoGoDate(config, now),
    phaseDomains: config.phases.find((phase) => phase.id === rollout.phase)?.domains || [],
    rollout,
    meta: {
      ingestSuccessRate: Number(meta.ingestSuccessRate ?? meta.ingest_success_rate ?? 0),
      scenarioEvidenceRate: Number(meta.scenarioEvidenceRate ?? meta.scenario_evidence_rate ?? 0),
      baselineId: String(meta.baselineId || meta.baseline_id || rollout.baselineId || ''),
    },
    ingestPayload: {
      rolloutGateRun: {
        phaseId: rollout.phase,
        status: rollout.overallStatus,
        generatedAt,
        payload: {
          ...rollout,
          meta: {
            ingestSuccessRate: Number(meta.ingestSuccessRate ?? meta.ingest_success_rate ?? 0),
            scenarioEvidenceRate: Number(
              meta.scenarioEvidenceRate ?? meta.scenario_evidence_rate ?? 0,
            ),
          },
        },
      },
    },
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`[harness-rollout-gates] wrote ${outputPath}`);

  if (enforce && rollout.overallStatus !== 'pass') {
    console.error(
      `[harness-rollout-gates] enforce mode active, failing because overallStatus=${rollout.overallStatus}`,
    );
    process.exit(1);
  }
}

main();
