import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('KnowledgeGraphPanel viewport guard', () => {
  it('waits for non-zero viewport dimensions before mounting ReactFlow', () => {
    const source = read('src/components/knowledge/graph/KnowledgeGraphPanel.tsx');

    expect(source).toContain('const graphViewportRef = useRef<HTMLDivElement | null>(null);');
    expect(source).toContain('const [viewport, setViewport] = useState({ width: 0, height: 0 });');
    expect(source).toContain('viewport.width > 0 && viewport.height > 0');
    expect(source).toContain('ref={graphViewportRef}');
  });
});
