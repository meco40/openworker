'use client';

import React, { useMemo } from 'react';

/**
 * Lightweight inline Markdown renderer for the Agent Room chat feed.
 * Supports: headings, bold, italic, inline code, code blocks,
 * bullet/numbered lists, horizontal rules, and line breaks.
 * No external dependencies required.
 */

interface InlineMarkdownProps {
  text: string;
  className?: string;
  children?: React.ReactNode;
}

interface MarkdownNode {
  type:
    | 'text'
    | 'bold'
    | 'italic'
    | 'code'
    | 'codeblock'
    | 'list'
    | 'orderedlist'
    | 'heading'
    | 'hr';
  content: string;
  language?: string;
  /** Heading level 1-6 */
  level?: number;
}

function isHorizontalRuleLine(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (!/^[\s*_-]+$/.test(trimmed)) return false;
  return trimmed.replace(/\s/g, '').length >= 3;
}

function parseBlocks(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  // Split by code fences first
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3);
      const newlineIdx = inner.indexOf('\n');
      const language = newlineIdx > 0 ? inner.slice(0, newlineIdx).trim() : '';
      const code = newlineIdx > 0 ? inner.slice(newlineIdx + 1) : inner;
      nodes.push({ type: 'codeblock', content: code.trimEnd(), language });
    } else if (part.trim()) {
      const lines = part.split('\n');
      let buffer: string[] = [];
      let listBuffer: string[] = [];
      let listType: 'list' | 'orderedlist' | null = null;

      const flushText = () => {
        if (buffer.length > 0) {
          const joined = buffer.join('\n');
          if (joined.trim()) {
            nodes.push({ type: 'text', content: joined });
          }
          buffer = [];
        }
      };

      const flushList = () => {
        if (listBuffer.length > 0 && listType) {
          nodes.push({ type: listType, content: listBuffer.join('\n') });
          listBuffer = [];
          listType = null;
        }
      };

      for (const line of lines) {
        const headingMatch = /^(#{1,6})\s+(.+)/.exec(line);
        const hrMatch = isHorizontalRuleLine(line);
        const bulletMatch = /^[\s]*[-*+]\s+(.+)/.exec(line);
        const orderedMatch = /^[\s]*\d+[.)]\s+(.+)/.exec(line);
        // Solo dash/double-dash on its own line → treat as separator (common in LLM output)
        const soloDash = /^-{1,2}$/.test(line.trim());

        if (headingMatch) {
          flushList();
          flushText();
          nodes.push({
            type: 'heading',
            content: headingMatch[2],
            level: headingMatch[1].length,
          });
        } else if ((hrMatch && !bulletMatch) || soloDash) {
          flushList();
          flushText();
          nodes.push({ type: 'hr', content: '' });
        } else if (bulletMatch) {
          if (listType === 'orderedlist') flushList();
          flushText();
          listType = 'list';
          listBuffer.push(bulletMatch[1]);
        } else if (orderedMatch) {
          if (listType === 'list') flushList();
          flushText();
          listType = 'orderedlist';
          listBuffer.push(orderedMatch[1]);
        } else {
          flushList();
          buffer.push(line);
        }
      }
      flushList();
      flushText();
    } else {
      nodes.push({ type: 'text', content: part });
    }
  }
  return nodes;
}

function renderInlineFormatting(text: string): React.ReactNode[] {
  // Process bold (**text** or __text__), italic (*text* or _text_), and inline code (`text`)
  const parts: React.ReactNode[] = [];
  const regex =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*(?!\*)[^*]+\*(?!\*)|(?<!_)_(?!_)[^_]+_(?!_))/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={match.index}
          className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.85em] text-cyan-300"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      parts.push(
        <strong key={match.index} className="font-semibold text-zinc-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      parts.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    } else {
      parts.push(token);
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'text-lg font-bold text-zinc-100 mt-3 mb-1.5',
  2: 'text-base font-bold text-zinc-100 mt-2.5 mb-1',
  3: 'text-sm font-semibold text-zinc-200 mt-2 mb-1',
  4: 'text-sm font-semibold text-zinc-300 mt-1.5 mb-0.5',
  5: 'text-xs font-semibold text-zinc-300 mt-1 mb-0.5',
  6: 'text-xs font-medium text-zinc-400 mt-1 mb-0.5',
};

function MarkdownBlock({ node }: { node: MarkdownNode }) {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Math.max(node.level ?? 3, 1), 6);
      const Tag = `h${level}` as keyof Pick<
        React.JSX.IntrinsicElements,
        'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      >;
      return <Tag className={HEADING_CLASSES[level]}>{renderInlineFormatting(node.content)}</Tag>;
    }
    case 'hr':
      return <hr className="my-2 border-zinc-700" />;
    case 'codeblock':
      return (
        <div className="my-1.5 overflow-x-auto rounded border border-zinc-700 bg-zinc-900/80">
          {node.language && (
            <div className="border-b border-zinc-700 px-3 py-0.5 text-[10px] text-zinc-500">
              {node.language}
            </div>
          )}
          <pre className="p-3 font-mono text-xs leading-relaxed text-zinc-300">
            <code>{node.content}</code>
          </pre>
        </div>
      );
    case 'list':
      return (
        <ul className="my-1 list-disc space-y-0.5 pl-5 text-sm">
          {node.content.split('\n').map((item, i) => (
            <li key={i}>{renderInlineFormatting(item)}</li>
          ))}
        </ul>
      );
    case 'orderedlist':
      return (
        <ol className="my-1 list-decimal space-y-0.5 pl-5 text-sm">
          {node.content.split('\n').map((item, i) => (
            <li key={i}>{renderInlineFormatting(item)}</li>
          ))}
        </ol>
      );
    case 'text':
    default:
      return <span className="whitespace-pre-wrap">{renderInlineFormatting(node.content)}</span>;
  }
}

export function InlineMarkdown({ text, className = '', children }: InlineMarkdownProps) {
  const nodes = useMemo(() => parseBlocks(text), [text]);

  return (
    <div className={`text-sm leading-relaxed wrap-break-word ${className}`}>
      {nodes.map((node, i) => (
        <MarkdownBlock key={i} node={node} />
      ))}
      {children}
    </div>
  );
}
