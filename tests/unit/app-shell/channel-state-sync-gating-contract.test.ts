import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('channel state sync gating contract', () => {
  it('guards websocket/channel-state sync behind an enabled flag', () => {
    const hookPath = path.resolve('src/modules/app-shell/useChannelStateSync.ts');
    const appPath = path.resolve('src/modules/app-shell/App.tsx');
    const hookSource = fs.readFileSync(hookPath, 'utf8');
    const appSource = fs.readFileSync(appPath, 'utf8');

    expect(hookSource).toContain('enabled: boolean;');
    expect(hookSource).toContain('if (!enabled) {');
    expect(appSource).toContain('shouldEnableChannelStateSync');
    expect(appSource).toContain('enabled: shouldEnableChannelStateSync');
  });
});
