import { execSync } from 'node:child_process';
import {
  classifyChangedDomains,
  getScenarioById,
  listActiveDomainIds,
  isHighRiskPath,
  loadDomainRegistry,
  loadScenarioMatrix,
  parseCommitTrailers,
  readContractLastReviewed,
} from '@/server/ci/harnessDomainRegistry';

interface PolicyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function git(command: string): string {
  return execSync(`git ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getChangedFiles(): string[] {
  const before = String(process.env.GITHUB_EVENT_BEFORE || '').trim();
  const sha = String(process.env.GITHUB_SHA || '').trim() || git('rev-parse HEAD');

  let filesRaw = '';
  if (before && !/^0+$/.test(before)) {
    filesRaw = git(`diff --name-only ${before} ${sha}`);
  } else {
    filesRaw = git(`show --name-only --pretty='' ${sha}`);
  }

  return filesRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, '/'));
}

function getHeadCommitMessage(): string {
  return git('log -1 --pretty=%B');
}

function getCommitMessagesForRange(): string[] {
  const before = String(process.env.GITHUB_EVENT_BEFORE || '').trim();
  const sha = String(process.env.GITHUB_SHA || '').trim() || git('rev-parse HEAD');
  const separator = '\u001e';

  if (!before || /^0+$/.test(before)) {
    return [getHeadCommitMessage()];
  }

  const range = git(`log --format=%B%x1e ${before}..${sha}`);
  return range
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isLikelyCodePath(filePath: string): boolean {
  return (
    filePath.startsWith('app/') || filePath.startsWith('src/') || filePath.startsWith('.github/')
  );
}

function validateLastReviewed(contractPath: string): boolean {
  const reviewed = readContractLastReviewed(contractPath);
  if (!reviewed) return false;
  const ageMs = Date.now() - Date.parse(`${reviewed}T00:00:00.000Z`);
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  return Number.isFinite(ageMs) && ageMs <= maxAgeMs;
}

function runPolicy(): PolicyResult {
  const registry = loadDomainRegistry();
  const scenarioMatrix = loadScenarioMatrix();
  const changedFiles = getChangedFiles();
  const commitMessages = getCommitMessagesForRange();
  const trailerSets = commitMessages.map((message) => parseCommitTrailers(message));

  const errors: string[] = [];
  const warnings: string[] = [];

  const scenarioIds = new Set(scenarioMatrix.scenarios.map((scenario) => scenario.id));
  const domainMatches = classifyChangedDomains(changedFiles, registry);
  const changedDomainIds = new Set(domainMatches.keys());
  const activeDomainIds = new Set(listActiveDomainIds(registry));

  const uncoveredCodeFiles = changedFiles.filter((filePath) => {
    if (!isLikelyCodePath(filePath)) return false;
    if (filePath.startsWith('.github/')) return false;
    if (filePath.startsWith('docs/archive/')) return false;
    for (const [, files] of domainMatches.entries()) {
      if (files.includes(filePath)) return false;
    }
    return true;
  });
  if (uncoveredCodeFiles.length > 0) {
    errors.push(
      `Changed files are not covered by DOMAIN_REGISTRY paths: ${uncoveredCodeFiles.join(', ')}`,
    );
  }

  const staleContracts = registry.domains
    .map((domain) => domain.contract)
    .filter((contractPath, index, list) => list.indexOf(contractPath) === index)
    .filter((contractPath) => !validateLastReviewed(contractPath));
  if (staleContracts.length > 0) {
    errors.push(`Contract Last Reviewed exceeded 30 days or missing: ${staleContracts.join(', ')}`);
  }

  const hasHighRiskChanges = changedFiles.some((filePath) => isHighRiskPath(filePath));
  const anyHumanApproval = trailerSets.some((trailers) => {
    const value = String(trailers['human-approval'] || 'none')
      .trim()
      .toLowerCase();
    return value !== 'none' && value.length > 0;
  });
  if (hasHighRiskChanges && !anyHumanApproval) {
    errors.push('High-risk path changes require Human-Approval trailer with approver handle.');
  }

  const touchedUnknownScenarioDomains = new Set<string>();
  const touchedDomains = Array.from(changedDomainIds).filter((domainId) =>
    activeDomainIds.has(domainId),
  );

  for (const trailers of trailerSets) {
    const agenticChange = String(trailers['agentic-change'] || 'no').toLowerCase();
    const riskClass = String(trailers['risk-class'] || '').toLowerCase();
    const harnessScenario = String(trailers['harness-scenario'] || '').trim();
    const harnessEvidence = String(trailers['harness-evidence'] || '').trim();
    const humanApproval = String(trailers['human-approval'] || 'none')
      .trim()
      .toLowerCase();

    if (agenticChange === 'yes') {
      if (!harnessScenario || !scenarioIds.has(harnessScenario)) {
        errors.push(
          'Agentic commit requires valid Harness-Scenario trailer from DOMAIN_SCENARIO_MATRIX.',
        );
      }
      if (!harnessEvidence.startsWith('https://')) {
        errors.push('Agentic commit requires Harness-Evidence trailer with https URL.');
      }
      if (!['low', 'medium', 'high'].includes(riskClass)) {
        errors.push('Agentic commit requires Risk-Class trailer: low|medium|high.');
      }

      const scenario = getScenarioById(scenarioMatrix, harnessScenario);
      if (scenario) {
        const scenarioDomainSet = new Set(scenario.domains);
        const intersectsChangedDomains = touchedDomains.some((domainId) =>
          scenarioDomainSet.has(domainId),
        );
        if (!intersectsChangedDomains && touchedDomains.length > 0) {
          errors.push(
            `Harness-Scenario "${harnessScenario}" does not cover changed domains: ${touchedDomains.join(', ')}`,
          );
        }
        for (const domainId of scenario.domains) {
          if (!activeDomainIds.has(domainId)) {
            touchedUnknownScenarioDomains.add(domainId);
          }
        }
      }
    } else if (agenticChange !== 'no') {
      warnings.push('Agentic-Change trailer missing or invalid. Treating commit as human-only.');
    }

    if (hasHighRiskChanges && (humanApproval === 'none' || !humanApproval)) {
      warnings.push(
        'One or more commits miss Human-Approval trailer while high-risk paths changed.',
      );
    }
  }

  if (touchedUnknownScenarioDomains.size > 0) {
    errors.push(
      `Scenario matrix references unknown domains: ${Array.from(touchedUnknownScenarioDomains).join(', ')}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

const result = runPolicy();
for (const warning of result.warnings) {
  console.log(`[main-policy][warn] ${warning}`);
}
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[main-policy][error] ${error}`);
  }
  process.exit(1);
}
console.log('[main-policy] policy checks passed.');
