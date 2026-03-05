import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('harness engineering governance contracts', () => {
  it('classifies CI into blocking and async lanes', () => {
    const blocking = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    const asyncWorkflow = fs.readFileSync('.github/workflows/async-quality.yml', 'utf8');

    expect(blocking).toContain('Blocking Gates');
    expect(blocking).toContain('Main Policy');
    expect(blocking).toContain('scripts/ci/main-policy-check.ts');
    expect(blocking).toContain('pnpm run typecheck');
    expect(blocking).toContain('pnpm run lint');
    expect(blocking).toContain('pnpm run test:e2e:smoke');

    expect(asyncWorkflow).toContain('Async Quality Gates');
    expect(asyncWorkflow).toContain('pnpm run test:coverage');
    expect(asyncWorkflow).toContain('pnpm run test:e2e:browser:ci');
    expect(asyncWorkflow).toContain('Live E2E (Async)');
    expect(asyncWorkflow).toContain('Async SLA Follow-up');
    expect(asyncWorkflow).toContain('MEM0_BASE_URL');
    expect(asyncWorkflow).toContain('MEM0_API_KEY');
  });

  it('keeps main guardian workflow for deterministic post-push safety', () => {
    const workflow = fs.readFileSync('.github/workflows/main-guardian.yml', 'utf8');
    expect(workflow).toContain('Main Guardian');
    expect(workflow).toContain("workflows: ['Blocking Gates']");
    expect(workflow).toContain('Auto Revert Failed Main Commit');
    expect(workflow).toContain('revert(guardian): auto-revert failing main commit');
  });

  it('keeps required fields in pull request template', () => {
    const template = fs.readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');

    expect(template).toContain('## Goal');
    expect(template).toContain('## Non-Goals');
    expect(template).toContain('## Blocking Gates');
    expect(template).toContain('## Async Follow-Ups (24h SLA)');
    expect(template).toContain('## Agentic Change');
    expect(template).toContain('## Harness Scenario Evidence');
    expect(template).toContain('chat-stream');
    expect(template).toContain('persona-switch');
    expect(template).toContain('master-run-feedback');
    expect(template).toContain('## PR Size');
    expect(template).toContain('## Split Rationale (>500 LOC)');
  });

  it('keeps architecture guards as a dedicated blocking context', () => {
    const blocking = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(blocking).toContain('Architecture Guards');
    expect(blocking).toContain('pnpm run test:architecture:guards');
  });

  it('keeps weekly cleanup in analyze/apply draft-pr stages with guardrails', () => {
    const cleanup = fs.readFileSync('.github/workflows/weekly-low-risk-cleanup.yml', 'utf8');
    expect(cleanup).toContain('analyze');
    expect(cleanup).toContain('apply-and-open-draft-pr');
    expect(cleanup).toContain('CLEANUP_DRAFT_PR_ENABLED');
    expect(cleanup).toContain('max_files');
    expect(cleanup).toContain('max_changed_lines');
  });

  it('keeps engineering snapshot workflow with ingest + alert policy', () => {
    const workflow = fs.readFileSync('.github/workflows/engineering-metrics-snapshot.yml', 'utf8');
    expect(workflow).toContain('Engineering Metrics Snapshot');
    expect(workflow).toContain('Build snapshot payload');
    expect(workflow).toContain('Ingest snapshot into internal API');
    expect(workflow).toContain('Apply metrics alert policy');
  });

  it('keeps domain registry and scenario matrix as source-of-truth artifacts', () => {
    const registry = fs.readFileSync('docs/contracts/DOMAIN_REGISTRY.json', 'utf8');
    const matrix = fs.readFileSync('docs/contracts/DOMAIN_SCENARIO_MATRIX.json', 'utf8');
    const runbook = fs.readFileSync('docs/runbooks/HARNESS_INCIDENT_TRIAGE.md', 'utf8');
    expect(registry).toContain('"domains"');
    expect(matrix).toContain('"scenarios"');
    expect(runbook).toContain('Harness-Events werden max. 90 Tage gehalten');
  });
});
