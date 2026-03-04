import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useGatewayConnection auto-connect contract', () => {
  it('supports disabling automatic connect', () => {
    const filePath = path.resolve('src/modules/gateway/useGatewayConnection.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('autoConnect?: boolean;');
    expect(source).toContain('const autoConnect = options?.autoConnect ?? true;');
    expect(source).toContain('if (!autoConnect) {');
    expect(source).toContain('client.connect()');
  });
});
