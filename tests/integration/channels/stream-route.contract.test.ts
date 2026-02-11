import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  return fs.readFileSync(absolutePath, 'utf-8');
}

describe('channels stream route contract', () => {
  it('maintains keepalive behavior in both legacy and v2 SSE paths', () => {
    const routeSource = read('app/api/channels/stream/route.ts');
    const keepaliveOccurrences = (routeSource.match(/: keepalive\\n\\n/g) || []).length;

    expect(keepaliveOccurrences).toBeGreaterThanOrEqual(2);
  });
});
