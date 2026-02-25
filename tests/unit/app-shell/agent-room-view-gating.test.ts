import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Agent Room view gating', () => {
  it('enables runtime, persona data, and skills for agent-room view', () => {
    const source = read('src/modules/app-shell/App.tsx');
    expect(source).toContain('currentView === View.AGENT_ROOM');
    expect(source).toContain('shouldEnableAgentRuntime');
    expect(source).toContain('shouldEnablePersonaData');
    expect(source).toContain('shouldLoadSkills');
  });
});

