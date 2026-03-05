import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACT_DOCS = [
  'docs/AGENT_ENGINEERING_INDEX.md',
  'docs/contracts/CHAT_AGENT_CONTRACT.md',
  'docs/contracts/MISSION_CONTROL_AGENT_CONTRACT.md',
] as const;

function read(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

function extractLastReviewed(content: string): string {
  const match = content.match(/- Last Reviewed:\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : '';
}

describe('agent contract docs metadata', () => {
  it('includes required metadata keys for all contract docs', () => {
    for (const filePath of CONTRACT_DOCS) {
      const content = read(filePath);
      expect(content).toContain('- Purpose:');
      expect(content).toContain('- Scope:');
      expect(content).toContain('- Source of Truth:');
      expect(content).toContain('- Last Reviewed:');
    }
  });

  it('enforces 30-day review freshness for contract docs', () => {
    const now = new Date();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

    for (const filePath of CONTRACT_DOCS) {
      const content = read(filePath);
      const reviewedAt = extractLastReviewed(content);
      expect(reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const ageMs = now.getTime() - new Date(`${reviewedAt}T00:00:00.000Z`).getTime();
      expect(ageMs).toBeLessThanOrEqual(maxAgeMs);
    }
  });
});
