import fs from 'node:fs';
import path from 'node:path';

export interface DomainRegistryDomain {
  id: string;
  display: string;
  systemDoc: string;
  contract: string;
  owner: string;
  risk: 'low' | 'medium' | 'high';
  paths: string[];
  scenarios: string[];
  tests: string[];
}

export interface DomainRegistry {
  version: number;
  generatedAt: string;
  domains: DomainRegistryDomain[];
}

export interface ScenarioDefinition {
  id: string;
  runner: 'vitest' | 'playwright' | 'shell';
  command: string;
  domains: string[];
}

export interface DomainScenarioMatrix {
  version: number;
  generatedAt: string;
  scenarios: ScenarioDefinition[];
}

const REGISTRY_PATH = path.resolve(process.cwd(), 'docs/contracts/DOMAIN_REGISTRY.json');
const SCENARIO_MATRIX_PATH = path.resolve(
  process.cwd(),
  'docs/contracts/DOMAIN_SCENARIO_MATRIX.json',
);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object in domain registry payload.');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  const parsed = String(value || '').trim();
  if (!parsed) {
    throw new Error(`Missing required field: ${field}`);
  }
  return parsed;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required non-empty array field: ${field}`);
  }
  return value.map((entry, index) => asString(entry, `${field}[${index}]`));
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

export function loadDomainRegistry(): DomainRegistry {
  const root = asRecord(readJsonFile(REGISTRY_PATH));
  const domainsRaw = Array.isArray(root.domains) ? root.domains : [];
  const domains = domainsRaw.map((entry, index) => {
    const row = asRecord(entry);
    const risk = asString(row.risk, `domains[${index}].risk`);
    if (!['low', 'medium', 'high'].includes(risk)) {
      throw new Error(`Invalid risk value for domain ${index}: ${risk}`);
    }
    return {
      id: asString(row.id, `domains[${index}].id`),
      display: asString(row.display, `domains[${index}].display`),
      systemDoc: asString(row.systemDoc, `domains[${index}].systemDoc`),
      contract: asString(row.contract, `domains[${index}].contract`),
      owner: asString(row.owner, `domains[${index}].owner`),
      risk: risk as DomainRegistryDomain['risk'],
      paths: asStringArray(row.paths, `domains[${index}].paths`),
      scenarios: asStringArray(row.scenarios, `domains[${index}].scenarios`),
      tests: asStringArray(row.tests, `domains[${index}].tests`),
    } satisfies DomainRegistryDomain;
  });

  if (domains.length === 0) {
    throw new Error('Domain registry must contain at least one domain.');
  }

  const seenIds = new Set<string>();
  const seenContracts = new Set<string>();
  for (const domain of domains) {
    if (seenIds.has(domain.id)) {
      throw new Error(`Duplicate domain id in registry: ${domain.id}`);
    }
    if (seenContracts.has(domain.contract)) {
      throw new Error(`Duplicate domain contract in registry: ${domain.contract}`);
    }
    seenIds.add(domain.id);
    seenContracts.add(domain.contract);
  }

  return {
    version: Number(root.version || 0),
    generatedAt: asString(root.generatedAt, 'generatedAt'),
    domains,
  };
}

export function loadScenarioMatrix(): DomainScenarioMatrix {
  const root = asRecord(readJsonFile(SCENARIO_MATRIX_PATH));
  const scenariosRaw = Array.isArray(root.scenarios) ? root.scenarios : [];
  const scenarios = scenariosRaw.map((entry, index) => {
    const row = asRecord(entry);
    const runner = asString(row.runner, `scenarios[${index}].runner`);
    if (!['vitest', 'playwright', 'shell'].includes(runner)) {
      throw new Error(`Invalid runner for scenario ${index}: ${runner}`);
    }
    return {
      id: asString(row.id, `scenarios[${index}].id`),
      runner: runner as ScenarioDefinition['runner'],
      command: asString(row.command, `scenarios[${index}].command`),
      domains: asStringArray(row.domains, `scenarios[${index}].domains`),
    } satisfies ScenarioDefinition;
  });

  const seenIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario id in matrix: ${scenario.id}`);
    }
    seenIds.add(scenario.id);
  }

  return {
    version: Number(root.version || 0),
    generatedAt: asString(root.generatedAt, 'generatedAt'),
    scenarios,
  };
}

export function parseCommitTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  const lines = String(message || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z-]+):\s*(.+)$/);
    if (!match) continue;
    trailers[match[1].toLowerCase()] = match[2].trim();
  }
  return trailers;
}

export function readContractLastReviewed(contractPath: string): string | null {
  const absolute = path.resolve(process.cwd(), contractPath);
  if (!fs.existsSync(absolute)) return null;
  const content = fs.readFileSync(absolute, 'utf8');
  const match = content.match(/- Last Reviewed:\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

function splitSegments(value: string): string[] {
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function wildcardSegmentMatches(patternSegment: string, candidateSegment: string): boolean {
  if (patternSegment === '*') return true;
  if (!patternSegment.includes('*')) return patternSegment === candidateSegment;

  const parts = patternSegment.split('*');
  let offset = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const foundAt = candidateSegment.indexOf(part, offset);
    if (foundAt < 0) return false;
    if (index === 0 && !patternSegment.startsWith('*') && foundAt !== 0) return false;
    offset = foundAt + part.length;
  }

  if (!patternSegment.endsWith('*') && offset !== candidateSegment.length) return false;
  return true;
}

function matchSegments(
  patternSegments: string[],
  candidateSegments: string[],
  patternIndex: number,
  candidateIndex: number,
): boolean {
  if (patternIndex >= patternSegments.length) {
    return candidateIndex >= candidateSegments.length;
  }

  const segment = patternSegments[patternIndex];
  if (segment === '**') {
    if (patternIndex === patternSegments.length - 1) return true;
    for (let cursor = candidateIndex; cursor <= candidateSegments.length; cursor += 1) {
      if (matchSegments(patternSegments, candidateSegments, patternIndex + 1, cursor)) {
        return true;
      }
    }
    return false;
  }

  if (candidateIndex >= candidateSegments.length) return false;
  if (!wildcardSegmentMatches(segment, candidateSegments[candidateIndex])) return false;
  return matchSegments(patternSegments, candidateSegments, patternIndex + 1, candidateIndex + 1);
}

export function pathMatchesPattern(candidatePath: string, pattern: string): boolean {
  const normalizedCandidate = String(candidatePath || '').replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/');
  const patternSegments = splitSegments(normalizedPattern);
  const candidateSegments = splitSegments(normalizedCandidate);
  return matchSegments(patternSegments, candidateSegments, 0, 0);
}

export function classifyChangedDomains(
  changedFiles: string[],
  registry: DomainRegistry,
): Map<string, string[]> {
  const matches = new Map<string, string[]>();
  for (const filePath of changedFiles) {
    const normalized = filePath.replace(/\\/g, '/');
    for (const domain of registry.domains) {
      if (domain.paths.some((pattern) => pathMatchesPattern(normalized, pattern))) {
        const current = matches.get(domain.id) || [];
        current.push(normalized);
        matches.set(domain.id, current);
      }
    }
  }
  return matches;
}

export function getScenarioById(
  matrix: DomainScenarioMatrix,
  scenarioId: string,
): ScenarioDefinition | null {
  const target = String(scenarioId || '').trim();
  if (!target) return null;
  return matrix.scenarios.find((scenario) => scenario.id === target) || null;
}

export function listActiveDomainIds(registry: DomainRegistry): string[] {
  return registry.domains.map((domain) => domain.id);
}

export function isHighRiskPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const highRiskPatterns = [
    'auth.ts',
    'app/api/auth/**',
    'app/api/security/**',
    'app/api/model-hub/pipeline/**',
    'src/server/auth/**',
    'src/server/security/**',
    'src/lib/db/migrations.ts',
    'src/server/gateway/**',
    'src/server/protocol/**',
    'src/server/memory/**',
    'src/core/memory/**',
    'src/server/model-hub/service/dispatch/**',
  ];
  return highRiskPatterns.some((pattern) => pathMatchesPattern(normalized, pattern));
}
