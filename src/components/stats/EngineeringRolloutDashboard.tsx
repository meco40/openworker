'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  GitMerge,
  ShieldAlert,
  Target,
  TrendingUp,
} from 'lucide-react';

type GateStatus = 'pass' | 'fail' | 'unknown';

type RolloutGate = {
  id: string;
  label: string;
  status: GateStatus;
  expected: number | null;
  actual: number | null;
  detail: string;
};

type EngineeringSnapshot = {
  windowDays: 7 | 30;
  firstPassCiRate: number | null;
  flakyRate: number | null;
  revertRate: number | null;
  mergeThroughputPerWeek: number | null;
  medianPrSize: number | null;
  asyncFailureSlaBreaches: number;
  criticalFailAutoReverts?: number;
  generatedAt: string;
  rollout?: {
    phase: string | null;
    phaseWindow: { start: string | null; end: string | null };
    mode: 'report-only' | 'enforce' | null;
    baselineId: string | null;
    overallStatus: GateStatus;
    recommendation: 'go' | 'hold' | 'rollback-hardening';
    exitGates: RolloutGate[];
    deltaVsBaseline: {
      firstPassCiRate: number | null;
      revertRate: number | null;
      flakyRate: number | null;
      mergeThroughputPerWeek: number | null;
      medianPrSize: number | null;
    };
  };
  domainCoverage?: {
    coverageRate: number | null;
    coveredDomains: number;
    activeDomains: number;
  };
};

type EngineeringResponse = {
  ok: boolean;
  error?: string;
  snapshot?: EngineeringSnapshot;
};

const WEEK_MEASUREMENTS: Array<{ week: string; target: string; source: string }> = [
  {
    week: 'Woche 1 (Shadow)',
    target: 'Domain/Contract-Abdeckung 100%, Ingest >= 99%',
    source: 'coverage + ingest-health',
  },
  {
    week: 'Woche 2 (Enforcement A)',
    target: 'Scenario-Evidence 100%, Critical Auto-Reverts = 0',
    source: 'evidence + guardian',
  },
  {
    week: 'Woche 3 (Enforcement B)',
    target: 'Flaky 7d < 2%, Scenario-Evidence 100%',
    source: 'flaky + evidence',
  },
  {
    week: 'Woche 4 (Enforcement C + Go/No-Go)',
    target: 'First-pass +15%, Revert-Rate nicht schlechter, Flaky < 2%',
    source: 'baseline deltas + stability',
  },
];

const WEEK_PHASE_ORDER = ['week-1', 'week-2', 'week-3', 'week-4'] as const;

function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value * 10000) / 100}%`;
}

function fmtSignedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const pct = Math.round(value * 10000) / 100;
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return String(Math.round(value * 100) / 100);
}

function gateBadge(status: GateStatus): string {
  if (status === 'pass')
    return 'border-mc-accent-green/50 bg-mc-accent-green/10 text-mc-accent-green';
  if (status === 'fail') return 'border-mc-accent-red/50 bg-mc-accent-red/10 text-mc-accent-red';
  return 'border-mc-accent-yellow/50 bg-mc-accent-yellow/10 text-mc-accent-yellow';
}

function phaseBadge(mode: 'report-only' | 'enforce' | null): string {
  if (mode === 'enforce')
    return 'border-mc-accent-purple/40 bg-mc-accent-purple/10 text-mc-accent-purple';
  if (mode === 'report-only')
    return 'border-mc-accent-cyan/40 bg-mc-accent-cyan/10 text-mc-accent-cyan';
  return 'border-mc-border bg-mc-bg-tertiary text-mc-text-secondary';
}

function recommendationBadge(recommendation: string | null | undefined): string {
  if (recommendation === 'go')
    return 'border-mc-accent-green/50 bg-mc-accent-green/10 text-mc-accent-green';
  if (recommendation === 'rollback-hardening')
    return 'border-mc-accent-red/50 bg-mc-accent-red/10 text-mc-accent-red';
  return 'border-mc-accent-yellow/50 bg-mc-accent-yellow/10 text-mc-accent-yellow';
}

export default function EngineeringRolloutDashboard() {
  const [snapshot7, setSnapshot7] = useState<EngineeringSnapshot | null>(null);
  const [snapshot30, setSnapshot30] = useState<EngineeringSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const [res7, res30] = await Promise.all([
          fetch('/api/stats/engineering?windowDays=7', { signal: controller.signal }),
          fetch('/api/stats/engineering?windowDays=30', { signal: controller.signal }),
        ]);
        const [json7, json30] = (await Promise.all([res7.json(), res30.json()])) as [
          EngineeringResponse,
          EngineeringResponse,
        ];

        if (!json7.ok || !json7.snapshot) {
          throw new Error(json7.error || '7d snapshot missing');
        }
        if (!json30.ok || !json30.snapshot) {
          throw new Error(json30.error || '30d snapshot missing');
        }

        setSnapshot7(json7.snapshot);
        setSnapshot30(json30.snapshot);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, []);

  const rollout = snapshot30?.rollout || null;
  const activePhaseIndex = rollout?.phase
    ? WEEK_PHASE_ORDER.indexOf(rollout.phase as (typeof WEEK_PHASE_ORDER)[number])
    : -1;

  const topCards = useMemo(
    () => [
      {
        label: 'First-pass CI (30d)',
        value: fmtPercent(snapshot30?.firstPassCiRate),
        icon: <Target className="h-4 w-4" />,
      },
      {
        label: 'Flaky Rate (7d)',
        value: fmtPercent(snapshot7?.flakyRate),
        icon: <Activity className="h-4 w-4" />,
      },
      {
        label: 'Revert Rate (30d)',
        value: fmtPercent(snapshot30?.revertRate),
        icon: <ShieldAlert className="h-4 w-4" />,
      },
      {
        label: 'Merge Throughput (30d)',
        value: fmtNumber(snapshot30?.mergeThroughputPerWeek),
        icon: <GitMerge className="h-4 w-4" />,
      },
      {
        label: 'Median PR Size (30d)',
        value: fmtNumber(snapshot30?.medianPrSize),
        icon: <TrendingUp className="h-4 w-4" />,
      },
      {
        label: 'Async SLA Breaches (7d)',
        value: String(snapshot7?.asyncFailureSlaBreaches ?? 0),
        icon: <AlertTriangle className="h-4 w-4" />,
      },
    ],
    [snapshot7, snapshot30],
  );

  return (
    <div className="bg-mc-bg min-h-screen">
      <header className="border-mc-border bg-mc-bg-secondary border-b">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-mc-text text-xl font-semibold">
                Engineering Rollout Live Dashboard
              </p>
              <p className="text-mc-text-secondary text-sm">
                Kompakte Live-Sicht fuer Harness Phase, Gates, KPI-Trends und Go/No-Go.
              </p>
            </div>
            <Link
              href="/mission-control"
              className="border-mc-border hover:bg-mc-bg-tertiary rounded border px-3 py-2 text-sm"
            >
              Zurueck zu Mission Control
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {loading && (
          <div className="bg-mc-bg-secondary border-mc-border rounded-lg border p-6 text-sm">
            Daten werden geladen...
          </div>
        )}

        {error && (
          <div className="border-mc-accent-red/40 bg-mc-accent-red/10 text-mc-accent-red rounded-lg border p-6 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && snapshot7 && snapshot30 && (
          <>
            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {topCards.map((card) => (
                <div
                  key={card.label}
                  className="bg-mc-bg-secondary border-mc-border rounded-lg border p-4"
                >
                  <div className="text-mc-text-secondary mb-2 flex items-center gap-2 text-xs uppercase">
                    {card.icon}
                    {card.label}
                  </div>
                  <div className="text-mc-text text-2xl font-semibold">{card.value}</div>
                </div>
              ))}
            </section>

            <section className="bg-mc-bg-secondary border-mc-border rounded-lg border p-5">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <p className="text-mc-text text-lg font-semibold">Aktive Rollout-Phase</p>
                <span
                  className={`rounded-full border px-2 py-1 text-xs ${phaseBadge(rollout?.mode || null)}`}
                >
                  {rollout?.mode || 'unknown'}
                </span>
                <span
                  className={`rounded-full border px-2 py-1 text-xs ${gateBadge(rollout?.overallStatus || 'unknown')}`}
                >
                  Overall: {rollout?.overallStatus || 'unknown'}
                </span>
                <span
                  className={`rounded-full border px-2 py-1 text-xs ${recommendationBadge(rollout?.recommendation)}`}
                >
                  Empfehlung: {rollout?.recommendation || 'hold'}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Phase</p>
                  <p className="text-mc-text mt-1 font-medium">{rollout?.phase || 'not active'}</p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Phase Window</p>
                  <p className="text-mc-text mt-1 text-sm">
                    {rollout?.phaseWindow.start || 'n/a'} bis {rollout?.phaseWindow.end || 'n/a'}
                  </p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Baseline</p>
                  <p className="text-mc-text mt-1 font-mono text-xs">
                    {rollout?.baselineId || 'n/a'}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Delta First-pass</p>
                  <p className="text-mc-text mt-1 text-lg">
                    {fmtSignedPercent(rollout?.deltaVsBaseline.firstPassCiRate)}
                  </p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Delta Revert-Rate</p>
                  <p className="text-mc-text mt-1 text-lg">
                    {fmtSignedPercent(rollout?.deltaVsBaseline.revertRate)}
                  </p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Critical Auto-Reverts (7d)</p>
                  <p className="text-mc-text mt-1 text-lg">
                    {snapshot7.criticalFailAutoReverts ?? 0}
                  </p>
                </div>
              </div>
            </section>

            <section className="bg-mc-bg-secondary border-mc-border rounded-lg border p-5">
              <p className="text-mc-text mb-4 text-lg font-semibold">Exit-Gates (aktive Phase)</p>
              <div className="space-y-3">
                {(rollout?.exitGates || []).map((gate) => (
                  <div key={gate.id} className="bg-mc-bg rounded border border-white/5 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-mc-text text-sm font-medium">{gate.label}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${gateBadge(gate.status)}`}
                      >
                        {gate.status}
                      </span>
                    </div>
                    <p className="text-mc-text-secondary text-xs">
                      Ist: {fmtNumber(gate.actual)} | Soll: {fmtNumber(gate.expected)} |{' '}
                      {gate.detail}
                    </p>
                  </div>
                ))}
                {(!rollout?.exitGates || rollout.exitGates.length === 0) && (
                  <div className="text-mc-text-secondary rounded border border-white/5 bg-black/10 p-3 text-sm">
                    Keine Gate-Daten verfuegbar.
                  </div>
                )}
              </div>
            </section>

            <section className="bg-mc-bg-secondary border-mc-border rounded-lg border p-5">
              <p className="text-mc-text mb-4 text-lg font-semibold">Woche 1 bis 4 Messplan</p>
              <div className="space-y-3">
                {WEEK_MEASUREMENTS.map((entry) => {
                  const weekNumberMatch = entry.week.match(/\d+/);
                  const weekIndex = weekNumberMatch ? Number(weekNumberMatch[0]) - 1 : -1;
                  const isActive = weekIndex >= 0 && weekIndex === activePhaseIndex;
                  const isCompleted = weekIndex >= 0 && activePhaseIndex > weekIndex;
                  return (
                    <div key={entry.week} className="bg-mc-bg rounded border border-white/5 p-3">
                      <div className="mb-1 flex items-center gap-2">
                        {isCompleted ? (
                          <CheckCircle2 className="text-mc-accent-green h-4 w-4" />
                        ) : isActive ? (
                          <CheckCircle2 className="text-mc-accent-green h-4 w-4" />
                        ) : (
                          <CircleDashed className="text-mc-text-secondary h-4 w-4" />
                        )}
                        <span className="text-mc-text text-sm font-medium">{entry.week}</span>
                      </div>
                      <p className="text-mc-text-secondary text-xs">Ziel: {entry.target}</p>
                      <p className="text-mc-text-secondary text-xs">Quelle: {entry.source}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="bg-mc-bg-secondary border-mc-border rounded-lg border p-5">
              <p className="text-mc-text mb-3 text-lg font-semibold">Abdeckung und Zeit</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Domain Coverage (30d)</p>
                  <p className="text-mc-text mt-1 text-lg">
                    {fmtPercent(snapshot30.domainCoverage?.coverageRate)}
                  </p>
                  <p className="text-mc-text-secondary text-xs">
                    {snapshot30.domainCoverage?.coveredDomains ?? 0}/
                    {snapshot30.domainCoverage?.activeDomains ?? 0}
                  </p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Aktualisiert (7d)</p>
                  <p className="text-mc-text mt-1 text-sm">{snapshot7.generatedAt}</p>
                </div>
                <div className="bg-mc-bg rounded border border-white/5 p-3">
                  <p className="text-mc-text-secondary text-xs">Aktualisiert (30d)</p>
                  <p className="text-mc-text mt-1 text-sm">{snapshot30.generatedAt}</p>
                </div>
              </div>
              <div className="text-mc-text-secondary mt-3 flex items-center gap-2 text-xs">
                <Clock3 className="h-3 w-3" />
                Live-Ansicht, Datenquelle: `GET /api/stats/engineering`
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
