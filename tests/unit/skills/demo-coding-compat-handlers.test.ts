import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPatchCompatHandler,
  editCompatHandler,
  readCompatHandler,
  writeCompatHandler,
} from '@/server/skills/handlers/codingCompat';
import type { SkillDispatchContext } from '@/server/skills/types';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function createWorkspace(): string {
  const dir = path.join(
    getTestArtifactsRoot(),
    'personas',
    'tool-compat-tests',
    `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('coding compat handlers', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0, workspaces.length)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('supports write/read/edit/apply_patch workflow inside workspace', async () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    const context: SkillDispatchContext = { workspaceCwd: workspace };

    await writeCompatHandler({ path: 'docs/note.txt', content: 'hello\nworld\n' }, context);

    const initial = (await readCompatHandler({ path: 'docs/note.txt' }, context)) as {
      content: string;
    };
    expect(initial.content).toContain('hello');
    expect(initial.content).toContain('world');

    await editCompatHandler(
      {
        path: 'docs/note.txt',
        oldText: 'world',
        newText: 'team',
      },
      context,
    );

    const edited = (await readCompatHandler({ path: 'docs/note.txt' }, context)) as {
      content: string;
    };
    expect(edited.content).toContain('team');

    await applyPatchCompatHandler(
      {
        input: [
          '*** Begin Patch',
          '*** Update File: docs/note.txt',
          '@@',
          '-hello',
          '+hola',
          '*** End Patch',
        ].join('\n'),
      },
      context,
    );

    const patched = (await readCompatHandler({ path: 'docs/note.txt' }, context)) as {
      content: string;
    };
    expect(patched.content).toContain('hola');
  });
});
