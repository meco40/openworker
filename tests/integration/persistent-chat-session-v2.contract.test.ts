import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled fixture path
  return fs.readFileSync(absolutePath, 'utf-8');
}

describe('persistent chat session v2 contract', () => {
  it('routes primary chat send path through server channels API', () => {
    const app = read('App.tsx');

    expect(app).toContain("fetch('/api/channels/messages'");
    expect(app).toContain('setIsServerResponding(true)');
    expect(app).toContain('isPersistentSessionV2Enabled');
  });
});
