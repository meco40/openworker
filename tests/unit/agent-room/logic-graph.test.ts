import { describe, expect, it } from 'vitest';
import {
  buildLogicGraphSource,
  extractMermaidBlocks,
  sanitizeMermaidSource,
} from '@/modules/agent-room/logicGraph';

describe('logic graph utilities', () => {
  it('extracts mermaid code blocks from artifact text', () => {
    const blocks = extractMermaidBlocks(
      'Start\n```mermaid\ngraph LR\nA-->B\n```\nText\n```mermaid\nflowchart TD\nX-->Y\n```',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('graph LR');
  });

  it('sanitizes risky directives and html tags', () => {
    const source = sanitizeMermaidSource('%%{init:{securityLevel:"loose"}}%%\n<script>bad()</script>\ngraph LR\nA-->B');
    expect(source).toContain('graph LR');
    expect(source).not.toContain('script');
    expect(source).not.toContain('init');
  });

  it('falls back to null when no graph source is present', () => {
    expect(buildLogicGraphSource('No graph here')).toBeNull();
  });
});

