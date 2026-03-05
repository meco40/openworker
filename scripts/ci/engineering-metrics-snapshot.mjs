import { writeFileSync } from 'node:fs';

const GITHUB_API = 'https://api.github.com';

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function ratio(numerator, denominator) {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function githubFetch(path, token) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'openworker-harness-metrics',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API failed (${response.status}): ${path}`);
  }
  return response.json();
}

async function paginate(path, token, maxPages = 5) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const chunk = await githubFetch(`${path}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    items.push(...chunk);
    if (chunk.length < 100) break;
  }
  return items;
}

function toIso(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function hoursBetween(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / (60 * 60 * 1000);
}

async function main() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  const outputPath =
    String(process.env.ENGINEERING_SNAPSHOT_OUTPUT || '').trim() ||
    'engineering-metrics-snapshot.json';

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!repository.includes('/')) throw new Error('GITHUB_REPOSITORY is required');

  const [owner, repo] = repository.split('/');
  const now = new Date();
  const nowIso = now.toISOString();
  const windows = [7, 30];
  const oldest30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const prs = await paginate(
    `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc`,
    token,
    6,
  );
  const mergedPrs = prs
    .filter((pr) => pr && pr.merged_at)
    .map((pr) => ({
      prNumber: Number(pr.number),
      createdAt: toIso(pr.created_at),
      mergedAt: toIso(pr.merged_at),
      additions: Number(pr.additions || 0),
      deletions: Number(pr.deletions || 0),
      headSha: String(pr.head?.sha || ''),
      reverted:
        String(pr.title || '').startsWith('Revert') ||
        String(pr.body || '')
          .toLowerCase()
          .includes('this reverts commit'),
    }))
    .filter((pr) => pr.createdAt && pr.mergedAt);

  const workflowRunsResponse = await githubFetch(
    `/repos/${owner}/${repo}/actions/runs?branch=main&per_page=100`,
    token,
  );
  const workflowRuns = Array.isArray(workflowRunsResponse.workflow_runs)
    ? workflowRunsResponse.workflow_runs
    : [];

  const blockingRuns = workflowRuns
    .filter((run) => run?.name === 'Blocking Gates')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const firstBlockingBySha = new Map();
  for (const run of blockingRuns) {
    const sha = String(run.head_sha || '');
    if (!sha) continue;
    const current = firstBlockingBySha.get(sha);
    if (!current || Date.parse(run.created_at) < Date.parse(current.created_at)) {
      firstBlockingBySha.set(sha, run);
    }
  }

  let blockingFailStreak = 0;
  for (const run of blockingRuns) {
    if (String(run.conclusion || '') === 'success') break;
    blockingFailStreak += 1;
  }

  const asyncRuns = workflowRuns.filter((run) => run?.name === 'Async Quality Gates');
  const relevantAsyncRuns = asyncRuns.filter((run) => {
    const created = Date.parse(run.created_at);
    return Number.isFinite(created) && created >= oldest30.getTime();
  });

  const laneEvents = [];
  for (const run of relevantAsyncRuns.slice(0, 40)) {
    const jobsResponse = await githubFetch(
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
      token,
    );
    const jobs = Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs : [];
    for (const job of jobs) {
      const lower = String(job.name || '').toLowerCase();
      let lane = null;
      if (lower.includes('coverage')) lane = 'coverage';
      if (lower.includes('browser e2e')) lane = 'browser';
      if (lower.includes('live e2e')) lane = 'live-e2e';
      if (lower.includes('flaky')) lane = 'flaky-detection';
      if (!lane) continue;

      const startedAt = toIso(job.started_at || run.run_started_at || run.created_at);
      const finishedAt = toIso(job.completed_at || run.updated_at);
      if (!startedAt || !finishedAt) continue;
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
      laneEvents.push({
        traceId: `run-${run.id}`,
        spanId: `job-${job.id}`,
        serviceName: 'github-actions',
        lane,
        status: String(job.conclusion || 'cancelled'),
        startedAt,
        finishedAt,
        durationMs,
        errorKind:
          String(job.conclusion || '') === 'success' ? null : String(job.conclusion || 'failure'),
        runUrl: String(run.html_url || ''),
      });
    }
  }

  const asyncSlaBreaches = await githubFetch(
    `/repos/${owner}/${repo}/issues?state=open&labels=async-failure,harness,sla-breached&per_page=100`,
    token,
  );
  const asyncFailureSlaBreaches = Array.isArray(asyncSlaBreaches)
    ? asyncSlaBreaches.filter((issue) => !issue.pull_request).length
    : 0;

  const snapshots = windows.map((windowDays) => {
    const fromMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
    const merged = mergedPrs.filter((pr) => Date.parse(pr.mergedAt) >= fromMs);
    const leadTimes = merged
      .map((pr) => hoursBetween(pr.createdAt, pr.mergedAt))
      .filter((value) => value !== null);
    const sizes = merged.map((pr) => Math.max(0, pr.additions + pr.deletions));
    const firstPassTrue = merged.filter((pr) => {
      const run = firstBlockingBySha.get(pr.headSha);
      return run && String(run.conclusion || '') === 'success';
    }).length;
    const reverted = merged.filter((pr) => pr.reverted).length;
    const flakyWindow = laneEvents.filter(
      (event) => event.lane === 'flaky-detection' && Date.parse(event.finishedAt) >= fromMs,
    );
    const flakyFailures = flakyWindow.filter((event) => event.status !== 'success').length;

    return {
      windowDays,
      leadTimeMedianHours: median(leadTimes) === null ? null : round2(median(leadTimes)),
      mergeThroughputPerWeek:
        merged.length <= 0 ? null : round2(merged.length / (Number(windowDays) / 7)),
      firstPassCiRate:
        ratio(firstPassTrue, merged.length) === null
          ? null
          : round2(ratio(firstPassTrue, merged.length)),
      flakyRate:
        ratio(flakyFailures, flakyWindow.length) === null
          ? null
          : round2(ratio(flakyFailures, flakyWindow.length)),
      revertRate:
        ratio(reverted, merged.length) === null ? null : round2(ratio(reverted, merged.length)),
      medianPrSize: median(sizes) === null ? null : Math.round(median(sizes)),
      asyncFailureSlaBreaches,
      generatedAt: nowIso,
      source: 'github-snapshot',
    };
  });

  const prFacts = mergedPrs
    .filter((pr) => Date.parse(pr.mergedAt) >= oldest30.getTime())
    .map((pr) => ({
      prNumber: pr.prNumber,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      firstPassBlocking: (() => {
        const run = firstBlockingBySha.get(pr.headSha);
        return Boolean(run && String(run.conclusion || '') === 'success');
      })(),
      reverted: pr.reverted,
    }));

  const payload = {
    snapshots,
    prFacts,
    events: laneEvents.map((event) => ({
      ...event,
      status:
        event.status === 'success' ||
        event.status === 'failure' ||
        event.status === 'cancelled' ||
        event.status === 'skipped'
          ? event.status
          : 'failure',
    })),
    meta: {
      generatedAt: nowIso,
      blockingFailStreak,
    },
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[engineering-metrics-snapshot] wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(
    '[engineering-metrics-snapshot] failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
