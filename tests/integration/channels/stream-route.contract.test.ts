import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('channels stream route contract', () => {
  it('removes the legacy SSE stream route', () => {
    const absolutePath = path.join(process.cwd(), 'app/api/channels/stream/route.ts');
    expect(fs.existsSync(absolutePath)).toBe(false);
  });
});
