import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('logic graph panel readability', () => {
  it('uses a larger graph canvas and bigger mermaid font for readability', () => {
    const source = read('src/modules/agent-room/components/LogicGraphPanel.tsx');
    expect(source).toContain("fontSize: '18px'");
    expect(source).toContain('min-h-[42rem]');
    expect(source).toContain('min-h-[38rem]');
    expect(source).not.toContain('max-h-[28rem]');
  });

  it('offers svg download instead of zoom controls', () => {
    const source = read('src/modules/agent-room/components/LogicGraphPanel.tsx');
    expect(source).toContain('Download SVG');
    expect(source).toContain('image/svg+xml;charset=utf-8');
    expect(source).toContain('URL.createObjectURL');
    expect(source).not.toContain('Zoom in');
    expect(source).not.toContain('Zoom out');
    expect(source).not.toContain('Reset zoom');
  });
});
