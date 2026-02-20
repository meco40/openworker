import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);

  return fs.readFileSync(absolutePath, 'utf-8');
}

describe('persistent chat session v2 contract', () => {
  it('routes primary chat send path through gateway streaming API', () => {
    const app = read('src/modules/app-shell/App.tsx');

    expect(app).toContain('requestStream(');
    expect(app).toContain("'chat.stream'");
    expect(app).toContain('setIsServerResponding(true)');
    expect(app).toContain('isPersistentSessionV2Enabled');
  });
});
