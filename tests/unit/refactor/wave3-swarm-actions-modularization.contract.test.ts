import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave3 swarm actions modularization contracts', () => {
  it('keeps useSwarmActions as facade over focused swarm action hooks', () => {
    const source = read('src/modules/agent-room/hooks/useSwarmActions.ts');

    expect(source).toContain(
      "from '@/modules/agent-room/hooks/swarm-actions/useSwarmCatalogActions'",
    );
    expect(source).toContain(
      "from '@/modules/agent-room/hooks/swarm-actions/useSwarmExecutionActions'",
    );
    expect(source).toContain(
      "from '@/modules/agent-room/hooks/swarm-actions/useSwarmCoordinationActions'",
    );
    expect(source).not.toContain('const loadCatalog = useCallback(async () => {');
    expect(source).not.toContain('const deploySwarm = useCallback(');
    expect(source).not.toContain('const forkSwarm = useCallback(');
  });
});
