import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyChangedDomains,
  getScenarioById,
  isHighRiskPath,
  listActiveDomainIds,
  loadDomainRegistry,
  loadScenarioMatrix,
  parseCommitTrailers,
  pathMatchesPattern,
  readContractLastReviewed,
} from '@/server/ci/harnessDomainRegistry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('harnessDomainRegistry branches', () => {
  it('loads registry and classifies changed files across wildcard patterns', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      if (normalized.endsWith('DOMAIN_REGISTRY.json')) {
        return JSON.stringify({
          version: 1,
          generatedAt: '2026-04-22T00:00:00.000Z',
          domains: [
            {
              id: 'security',
              display: 'Security',
              systemDoc: 'docs/security.md',
              contract: 'docs/contracts/SECURITY_AGENT_CONTRACT.md',
              owner: 'sec-team',
              risk: 'high',
              paths: ['src/server/security/**', 'app/api/security/**'],
              scenarios: ['security-smoke'],
              tests: ['tests/unit/security/*.test.ts'],
            },
            {
              id: 'tasks',
              display: 'Tasks',
              systemDoc: 'docs/tasks.md',
              contract: 'docs/contracts/TASKS_AGENT_CONTRACT.md',
              owner: 'tasks-team',
              risk: 'medium',
              paths: ['src/server/tasks/*.ts'],
              scenarios: ['tasks-smoke'],
              tests: ['tests/unit/tasks/*.test.ts'],
            },
          ],
        });
      }
      if (normalized.endsWith('DOMAIN_SCENARIO_MATRIX.json')) {
        return JSON.stringify({
          version: 1,
          generatedAt: '2026-04-22T00:00:00.000Z',
          scenarios: [
            {
              id: 'security-smoke',
              runner: 'vitest',
              command: 'corepack pnpm exec vitest run tests/unit/security/file-access.test.ts',
              domains: ['security'],
            },
          ],
        });
      }
      throw new Error(`Unexpected file read: ${normalized}`);
    });

    const registry = loadDomainRegistry();
    const matrix = loadScenarioMatrix();
    const changed = classifyChangedDomains(
      ['src/server/security/headers.ts', 'src/server/tasks/dispatch.ts'],
      registry,
    );

    expect(listActiveDomainIds(registry)).toEqual(['security', 'tasks']);
    expect(changed.get('security')).toEqual(['src/server/security/headers.ts']);
    expect(changed.get('tasks')).toEqual(['src/server/tasks/dispatch.ts']);
    expect(getScenarioById(matrix, 'security-smoke')?.runner).toBe('vitest');
    expect(getScenarioById(matrix, 'missing')).toBeNull();
  });

  it('rejects invalid registry and scenario payloads', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      if (normalized.endsWith('DOMAIN_REGISTRY.json')) {
        return JSON.stringify({
          version: 1,
          generatedAt: '2026-04-22T00:00:00.000Z',
          domains: [
            {
              id: 'dup',
              display: 'Duplicate',
              systemDoc: 'docs/one.md',
              contract: 'docs/contracts/ONE.md',
              owner: 'a',
              risk: 'critical',
              paths: ['src/one/**'],
              scenarios: ['one'],
              tests: ['tests/one.test.ts'],
            },
          ],
        });
      }
      if (normalized.endsWith('DOMAIN_SCENARIO_MATRIX.json')) {
        return JSON.stringify({
          version: 1,
          generatedAt: '2026-04-22T00:00:00.000Z',
          scenarios: [
            {
              id: 'dup',
              runner: 'unknown',
              command: 'echo nope',
              domains: ['dup'],
            },
          ],
        });
      }
      throw new Error(`Unexpected file read: ${normalized}`);
    });

    expect(() => loadDomainRegistry()).toThrow(/Invalid risk value/);
    expect(() => loadScenarioMatrix()).toThrow(/Invalid runner/);
  });

  it('parses commit trailers and contract last-reviewed dates safely', () => {
    const contractFile = path.resolve(process.cwd(), 'docs/contracts/SECURITY_AGENT_CONTRACT.md');
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return path.resolve(String(filePath)) === contractFile;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === contractFile) {
        return '# Contract\n- Last Reviewed: 2026-04-21\n';
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });

    expect(
      parseCommitTrailers(
        'feat: add thing\n\nDomain: security\nReviewed-By: codex\ninvalid trailer',
      ),
    ).toEqual({
      domain: 'security',
      feat: 'add thing',
      'reviewed-by': 'codex',
    });
    expect(readContractLastReviewed('docs/contracts/SECURITY_AGENT_CONTRACT.md')).toBe(
      '2026-04-21',
    );
    expect(readContractLastReviewed('../outside.md')).toBeNull();
    expect(readContractLastReviewed('')).toBeNull();
  });

  it('matches glob-like path patterns and detects high-risk paths', () => {
    expect(pathMatchesPattern('src/server/security/headers.ts', 'src/server/security/**')).toBe(
      true,
    );
    expect(pathMatchesPattern('src/server/tasks/dispatch.ts', 'src/server/tasks/*.ts')).toBe(true);
    expect(pathMatchesPattern('src/server/tasks/deep/dispatch.ts', 'src/server/tasks/*.ts')).toBe(
      false,
    );
    expect(pathMatchesPattern('app/api/security/status/route.ts', 'app/api/security/**')).toBe(
      true,
    );
    expect(isHighRiskPath('src/server/security/headers.ts')).toBe(true);
    expect(isHighRiskPath('src/server/tasks/dispatch.ts')).toBe(false);
  });
});
