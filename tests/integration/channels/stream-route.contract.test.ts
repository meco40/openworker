import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('channels stream route contract', () => {
  it('removes the legacy SSE stream route', () => {
    const absolutePath = path.join(process.cwd(), 'app/api/channels/stream/route.ts');
    expect(fs.existsSync(absolutePath)).toBe(false);
  });

  it('keeps websocket auth guard and principal fallback in custom server', () => {
    const serverPath = path.join(process.cwd(), 'server.ts');
    const source = fs.readFileSync(serverPath, 'utf8');

    expect(source).toContain('HTTP/1.1 401 Unauthorized');
    expect(source).toContain('getPrincipalUserId');
  });
});
