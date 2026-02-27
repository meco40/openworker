import { describe, expect, it, vi } from 'vitest';

const shellExecuteHandlerMock = vi.hoisted(() => vi.fn(async () => ({ alias: 'exec' })));
const processManagerHandlerMock = vi.hoisted(() => vi.fn(async () => ({ alias: 'process' })));

vi.mock('@/server/skills/handlers/shellExecute', () => ({
  shellExecuteHandler: shellExecuteHandlerMock,
}));

vi.mock('@/server/skills/handlers/processManager', () => ({
  processManagerHandler: processManagerHandlerMock,
}));

import { dispatchSkill } from '@/server/skills/executeSkill';

describe('dispatchSkill demo compatibility aliases', () => {
  it('routes exec and process aliases', async () => {
    const execResult = (await dispatchSkill('exec', { command: 'echo hi' })) as { alias: string };
    expect(execResult.alias).toBe('exec');

    const processResult = (await dispatchSkill('process', { action: 'list' })) as {
      alias: string;
    };
    expect(processResult.alias).toBe('process');

    expect(shellExecuteHandlerMock).toHaveBeenCalledWith({ command: 'echo hi' }, undefined);
    expect(processManagerHandlerMock).toHaveBeenCalledWith({ action: 'list' }, undefined);
  });
});
