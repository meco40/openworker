import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ConnectionStatus gateway contract', () => {
  it('renders a supplied gateway state without owning the connection lifecycle', () => {
    const filePath = path.resolve('src/components/ConnectionStatus.tsx');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('state: ConnectionState');
    expect(source).not.toContain('useGatewayConnection');
    expect(source).not.toContain("state === 'disconnected' ? 'idle' : state");
    expect(source).toContain('stateConfig[state] ?? stateConfig.disconnected');
  });
});
