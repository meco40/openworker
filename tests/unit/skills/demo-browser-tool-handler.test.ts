import { describe, expect, it } from 'vitest';
import { browserToolHandler } from '@/server/skills/handlers/browserTool';

describe('browser tool handler', () => {
  it('returns status when browser is not started', async () => {
    const status = (await browserToolHandler({ action: 'status' })) as {
      running: boolean;
    };
    expect(status.running).toBe(false);
  });

  it('rejects unsupported actions', async () => {
    await expect(browserToolHandler({ action: 'unsupported-action' })).rejects.toThrow(
      /Unsupported browser action/,
    );
  });
});
