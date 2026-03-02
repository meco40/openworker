import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave3 inbound pipeline contracts', () => {
  it('uses stage modules and keeps handleInbound as orchestrator', () => {
    const source = read('src/server/channels/messages/service/inbound/handleInbound.ts');

    expect(source).toContain("from './stages/createInboundContextStage'");
    expect(source).toContain("from './stages/routeCommandStage'");
    expect(source).toContain("from './stages/prepareDispatchStage'");
    expect(source).toContain("from './stages/dispatchModelStage'");
    expect(source).not.toContain("if (route.target === 'shell-command')");
    expect(source).not.toContain('dispatchToAI(');
  });
});
