import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Knowledge graph detail panel', () => {
  it('renders a node detail panel with relation list pagination', () => {
    const source = read('src/components/knowledge/graph/KnowledgeGraphPanel.tsx');

    expect(source).toContain('buildNodeRelationDetails(');
    expect(source).toContain('const [detailVisibleCount, setDetailVisibleCount] = useState(20);');
    expect(source).toContain('Mehr laden');
    expect(source).toContain('Focus aktiv (zurücksetzen)');
  });
});
