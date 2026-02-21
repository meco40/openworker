import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Knowledge graph motion strategy', () => {
  it('does not run per-frame setNodes animation loop in panel component', () => {
    const panel = read('src/components/knowledge/graph/KnowledgeGraphPanel.tsx');

    expect(panel).not.toContain('const frame = (timestamp: number) =>');
    expect(panel).not.toContain('requestAnimationFrame(frame)');
  });

  it('applies CSS-based drift classes in KnowledgeNode', () => {
    const node = read('src/components/knowledge/graph/KnowledgeNode.tsx');
    expect(node).toContain('knowledge-node');
    expect(node).toContain('knowledge-node--drift');
  });
});
