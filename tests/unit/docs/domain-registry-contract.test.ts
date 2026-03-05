import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadDomainRegistry,
  loadScenarioMatrix,
  readContractLastReviewed,
} from '@/server/ci/harnessDomainRegistry';

describe('domain registry contract', () => {
  it('keeps every domain mapped to exactly one contract and existing files', () => {
    const registry = loadDomainRegistry();
    const seenContracts = new Set<string>();

    expect(registry.domains.length).toBeGreaterThan(10);

    for (const domain of registry.domains) {
      expect(domain.id).toBeTruthy();
      expect(seenContracts.has(domain.contract)).toBe(false);
      seenContracts.add(domain.contract);

      const absoluteContract = path.resolve(process.cwd(), domain.contract);
      expect(fs.existsSync(absoluteContract)).toBe(true);

      const reviewedAt = readContractLastReviewed(domain.contract);
      expect(reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('ensures every scenario reference exists in scenario matrix', () => {
    const registry = loadDomainRegistry();
    const matrix = loadScenarioMatrix();
    const scenarioIds = new Set(matrix.scenarios.map((scenario) => scenario.id));

    for (const domain of registry.domains) {
      for (const scenario of domain.scenarios) {
        expect(scenarioIds.has(scenario)).toBe(true);
      }
    }
  });

  it('enforces 30-day freshness for all domain contracts', () => {
    const registry = loadDomainRegistry();
    const now = new Date();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

    for (const domain of registry.domains) {
      const reviewedAt = readContractLastReviewed(domain.contract);
      expect(reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const ageMs = now.getTime() - new Date(`${reviewedAt}T00:00:00.000Z`).getTime();
      expect(ageMs).toBeLessThanOrEqual(maxAgeMs);
    }
  });
});
