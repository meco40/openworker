import fs from 'node:fs';
import path from 'node:path';
import { isGoNoGoDate, loadHarnessRolloutConfig } from '@/server/stats/harnessRollout';

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

function main(): void {
  const reportPath =
    String(process.env.ROLL_OUT_GATE_OUTPUT || '').trim() ||
    path.resolve(process.cwd(), 'harness-rollout-gates-report.json');
  const outputPath =
    String(process.env.GO_NO_GO_OUTPUT || '').trim() ||
    path.resolve(process.cwd(), 'harness-go-no-go-report.json');
  const now = process.env.ROLLOUT_NOW_ISO
    ? new Date(String(process.env.ROLLOUT_NOW_ISO))
    : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('ROLLOUT_NOW_ISO is invalid.');
  }

  const config = loadHarnessRolloutConfig();
  const force = readBooleanEnv('GO_NO_GO_FORCE', false);
  const enforce = readBooleanEnv('GO_NO_GO_ENFORCE', false);
  const isDecisionDate = isGoNoGoDate(config, now);

  const gateRaw = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown;
  const gateReport = asRecord(gateRaw);
  if (!gateReport) {
    throw new Error('Rollout gate report is invalid.');
  }
  const rollout = asRecord(gateReport.rollout);
  if (!rollout) {
    throw new Error('Rollout section missing in gate report.');
  }
  const overallStatus = String(rollout.overallStatus || 'unknown') as 'pass' | 'fail' | 'unknown';
  const recommendation =
    overallStatus === 'pass'
      ? config.goNoGo.recommendationPolicy.pass
      : overallStatus === 'fail'
        ? config.goNoGo.recommendationPolicy.fail
        : config.goNoGo.recommendationPolicy.unknown;

  const failedGates = (Array.isArray(rollout.exitGates) ? rollout.exitGates : []).filter((gate) => {
    const record = asRecord(gate);
    if (!record) return false;
    return String(record.status || '') === 'fail';
  });
  const dueHours = Number(process.env.ROLLOUT_SLA_HOURS || config.sla.defaultHours || 24);
  const dueAt = new Date(now.getTime() + Math.max(1, dueHours) * 60 * 60 * 1000).toISOString();

  const output = {
    skipped: !force && !isDecisionDate,
    enforce,
    force,
    generatedAt: now.toISOString(),
    decisionDate: now.toISOString().slice(0, 10),
    recommendation,
    overallStatus,
    dueAt,
    failedGates: failedGates.map((gate) => ({
      id: String((gate as Record<string, unknown>).id || ''),
      label: String((gate as Record<string, unknown>).label || ''),
      detail: String((gate as Record<string, unknown>).detail || ''),
    })),
    rollout,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`[harness-go-no-go] wrote ${outputPath}`);

  if (enforce && recommendation !== 'go') {
    console.error(`[harness-go-no-go] enforce mode active, recommendation=${recommendation}`);
    process.exit(1);
  }
}

main();
