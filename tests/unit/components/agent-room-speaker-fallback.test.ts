import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('agent room speaker fallback', () => {
  it('uses active command speaker as parse fallback instead of always lead persona', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');

    expect(source).toContain('const commandInfo = runtime.getCommandInfo(event.commandId);');
    expect(source).toContain(
      'const fallbackPersonaId = commandInfo?.personaId || swarm.leadPersonaId;',
    );
    expect(source).toContain('parseAgentTurns(rawText, resolvedUnits, fallbackPersonaId)');
  });
});
