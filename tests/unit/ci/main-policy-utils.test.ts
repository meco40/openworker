import { describe, expect, it } from 'vitest';
import {
  classifyChangedDomains,
  getScenarioById,
  isHighRiskPath,
  loadDomainRegistry,
  loadScenarioMatrix,
  parseCommitTrailers,
} from '@/server/ci/harnessDomainRegistry';

describe('main policy utilities', () => {
  it('parses commit trailers case-insensitively', () => {
    const trailers = parseCommitTrailers(
      [
        'feat: improve harness policy',
        '',
        'Agentic-Change: yes',
        'Harness-Scenario: chat-stream',
        'Harness-Evidence: https://github.com/example/run/1',
        'Risk-Class: high',
        'Human-Approval: @owner',
      ].join('\n'),
    );

    expect(trailers['agentic-change']).toBe('yes');
    expect(trailers['harness-scenario']).toBe('chat-stream');
    expect(trailers['human-approval']).toBe('@owner');
  });

  it('flags high-risk path patterns', () => {
    expect(isHighRiskPath('src/server/auth/userContext.ts')).toBe(true);
    expect(isHighRiskPath('src/server/gateway/index.ts')).toBe(true);
    expect(isHighRiskPath('src/modules/chat/components/ChatMainPane.tsx')).toBe(false);
  });

  it('maps changed files to registry domains', () => {
    const registry = loadDomainRegistry();
    const matches = classifyChangedDomains(
      ['src/server/memory/service.ts', 'app/api/model-hub/pipeline/route.ts'],
      registry,
    );

    expect(matches.has('memory')).toBe(true);
    expect(matches.has('model-hub')).toBe(true);
  });

  it('keeps scenario ids unique', () => {
    const matrix = loadScenarioMatrix();
    const ids = matrix.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves scenario metadata by id', () => {
    const matrix = loadScenarioMatrix();
    const scenario = getScenarioById(matrix, 'chat-stream');
    expect(scenario).not.toBeNull();
    expect(scenario?.domains.includes('chat')).toBe(true);
  });
});
