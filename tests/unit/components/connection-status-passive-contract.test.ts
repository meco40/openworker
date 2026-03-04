import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ConnectionStatus passive gateway contract', () => {
  it('subscribes without forcing websocket connect on root shell mount', () => {
    const filePath = path.resolve('src/components/ConnectionStatus.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('useGatewayConnection({ autoConnect: false })');
    expect(source).toContain("state === 'disconnected' ? 'idle' : state");
  });
});
