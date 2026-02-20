import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);

  return fs.readFileSync(absolutePath, 'utf-8');
}

describe('turbopack path pattern guard', () => {
  it('avoids broad process.cwd path-join patterns that trigger file tracing warnings', () => {
    const files = [
      'src/logging/logRepository.ts',
      'src/server/auth/userStore.ts',
      'src/server/automation/sqliteAutomationRepository.ts',
      'src/server/channels/credentials/credentialStore.ts',
      'src/server/channels/messages/sqliteMessageRepository.ts',
      'src/server/memory/sqliteMemoryRepository.ts',
      'src/server/model-hub/repositories/sqliteModelHubRepository.ts',
      'src/server/security/status.ts',
      'src/server/skills/handlers/dbQuery.ts',
      'src/server/skills/handlers/fileRead.ts',
      'src/server/skills/skillRepository.ts',
      'src/server/stats/tokenUsageRepository.ts',
    ];

    for (const file of files) {
      const content = read(file);
      expect(content).not.toContain('path.join(process.cwd(),');
      expect(content).not.toContain('const workspaceRoot = process.cwd()');
    }
  });
});
