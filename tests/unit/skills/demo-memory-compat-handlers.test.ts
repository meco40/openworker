import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryGetHandler, memorySearchHandler } from '@/server/skills/handlers/memoryCompat';
import type { SkillDispatchContext } from '@/server/skills/types';

function createWorkspace(): string {
  const dir = path.join(
    process.cwd(),
    '.local',
    'personas',
    'tool-compat-tests',
    `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  return dir;
}

describe('memory compat handlers', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0, workspaces.length)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('finds snippets and reads ranges from MEMORY.md and memory/*.md', async () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    fs.writeFileSync(
      path.join(workspace, 'MEMORY.md'),
      'Deployment checklist\n- run tests\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspace, 'memory', 'ops.md'),
      'Release notes\nDeploy command is npm run build\nRollback command is git revert\n',
      'utf-8',
    );

    const context: SkillDispatchContext = { workspaceCwd: workspace };
    const search = (await memorySearchHandler(
      { query: 'deploy command', maxResults: 3 },
      context,
    )) as {
      results: Array<{ path: string; startLine: number }>;
    };

    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.some((entry) => entry.path.includes('ops.md'))).toBe(true);

    const first = search.results[0]!;
    const snippet = (await memoryGetHandler(
      { path: first.path, from: first.startLine, lines: 2 },
      context,
    )) as { text: string };

    expect(snippet.text.length).toBeGreaterThan(0);
  });
});
