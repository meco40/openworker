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

function validDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: 'domain-a',
    display: 'Domain A',
    systemDoc: 'docs/domain-a.md',
    contract: 'docs/contracts/DOMAIN_A.md',
    owner: 'team-a',
    risk: 'low',
    paths: ['src/domain-a/**'],
    scenarios: ['scenario-a'],
    tests: ['tests/domain-a.test.ts'],
    ...overrides,
  };
}

function mockRegistry(payload: unknown): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
    if (String(filePath).replace(/\\/g, '/').endsWith('DOMAIN_REGISTRY.json')) {
      return JSON.stringify(payload);
    }
    throw new Error(`Unexpected file read: ${String(filePath)}`);
  });
}

function mockScenarioMatrix(payload: unknown): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
    if (String(filePath).replace(/\\/g, '/').endsWith('DOMAIN_SCENARIO_MATRIX.json')) {
      return JSON.stringify(payload);
    }
    throw new Error(`Unexpected file read: ${String(filePath)}`);
  });
}

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

  it.each([
    [null, /Expected object/],
    [{ version: 1, generatedAt: 'today', domains: [] }, /at least one domain/],
    [{ version: 1, generatedAt: 'today', domains: 'invalid' }, /at least one domain/],
    [{ version: 1, generatedAt: 'today', domains: [null] }, /Expected object/],
    [{ version: 1, generatedAt: 'today', domains: [validDomain({ id: '' })] }, /domains\[0\]\.id/],
    [
      { version: 1, generatedAt: 'today', domains: [validDomain({ paths: [] })] },
      /domains\[0\]\.paths/,
    ],
    [
      {
        version: 1,
        generatedAt: 'today',
        domains: [validDomain(), validDomain({ id: 'domain-b' })],
      },
      /Duplicate domain contract/,
    ],
    [
      {
        version: 1,
        generatedAt: 'today',
        domains: [validDomain(), validDomain({ contract: 'docs/contracts/DOMAIN_B.md' })],
      },
      /Duplicate domain id/,
    ],
  ])('rejects malformed registry payloads', (payload, error) => {
    mockRegistry(payload);

    expect(() => loadDomainRegistry()).toThrow(error);
  });

  it('defaults an omitted registry version and rejects malformed scenario matrices', () => {
    mockRegistry({ generatedAt: 'today', domains: [validDomain()] });
    expect(loadDomainRegistry().version).toBe(0);

    for (const [payload, error] of [
      [null, /Expected object/],
      [{ generatedAt: 'today', scenarios: 'invalid' }, undefined],
      [
        {
          version: 1,
          generatedAt: 'today',
          scenarios: [
            { id: 'scenario-a', runner: 'shell', command: 'true', domains: ['domain-a'] },
            { id: 'scenario-a', runner: 'playwright', command: 'true', domains: ['domain-a'] },
          ],
        },
        /Duplicate scenario id/,
      ],
    ] as const) {
      mockScenarioMatrix(payload);
      if (error) expect(() => loadScenarioMatrix()).toThrow(error);
      else expect(loadScenarioMatrix()).toMatchObject({ version: 0, scenarios: [] });
      vi.restoreAllMocks();
    }

    mockScenarioMatrix({ generatedAt: 'today', scenarios: [{ id: 'broken' }] });
    expect(() => loadScenarioMatrix()).toThrow(/Missing required field: scenarios\[0\]\.runner/);
  });

  it.each([
    ['src/server/index.ts', 'src/*/index.ts', true],
    ['src/server/my-service.test.ts', 'src/server/*service*.ts', true],
    ['src/server/service.test.ts', 'src/server/*service*.ts', true],
    ['src/server/service.test.js', 'src/server/*service*.ts', false],
    ['src/server/xprefixSuffix.ts', 'src/server/prefix*suffix.ts', false],
    ['src/server/my-service.test.ts-extra', 'src/server/*service*.ts', false],
    ['src/route.ts', 'src/**/route.ts', true],
    ['src/server/api/route.ts', 'src/**/route.ts', true],
    ['src/server/route.ts', 'src/**', true],
    ['src/server/other.ts', 'src/**/route.ts', false],
    ['src/server/route.ts', 'src/*/route.ts', true],
    ['src', 'src/*', false],
    ['src\\server\\index.ts', 'src/*/index.ts', true],
    ['', '', true],
  ])('matches path pattern %s against %s', (candidate, pattern, expected) => {
    expect(pathMatchesPattern(candidate, pattern)).toBe(expected);
  });

  it('handles empty commit trailers, scenario identifiers, and unreviewed contracts', () => {
    expect(parseCommitTrailers('')).toEqual({});
    const emptyMatrix = { version: 1, generatedAt: 'today', scenarios: [] };
    expect(getScenarioById(emptyMatrix, '  ')).toBeNull();
    expect(getScenarioById(emptyMatrix, '')).toBeNull();

    const contractRoot = path.resolve(process.cwd(), 'docs/contracts');
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return path.resolve(String(filePath)) === contractRoot;
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue('# No review date');
    expect(readContractLastReviewed('.')).toBeNull();
    expect(readContractLastReviewed('missing.md')).toBeNull();
  });

  it('recognizes each high-risk path family and normalizes Windows separators', () => {
    for (const filePath of [
      'auth.ts',
      'app/api/auth/session/route.ts',
      'app/api/security/csp/route.ts',
      'app/api/model-hub/pipeline/route.ts',
      'src/server/auth/userContext.ts',
      'src/server/security/headers.ts',
      'src/lib/db/migrations.ts',
      'src/server/gateway/methods/chat.ts',
      'src/server/protocol/openai.ts',
      'src/server/memory/service.ts',
      'src/core/memory/cache.ts',
      'src/server/model-hub/service/dispatch/runner.ts',
    ]) {
      expect(isHighRiskPath(filePath)).toBe(true);
    }
    expect(isHighRiskPath('src\\server\\auth\\userContext.ts')).toBe(true);
  });
});
