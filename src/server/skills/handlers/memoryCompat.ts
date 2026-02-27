import fs from 'node:fs/promises';
import path from 'node:path';
import type { SkillDispatchContext } from '@/server/skills/types';
import { resolveWorkspaceRoot, resolveWorkspacePath } from '@/server/skills/handlers/workspaceFs';

type MemorySearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_SNIPPET_LINES = 3;
const MAX_RESULTS = 25;
const MAX_SNIPPET_LINES = 12;
const MAX_FILE_BYTES = 512_000;

export async function memorySearchHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const query = String(args.query || '').trim();
  if (!query) {
    throw new Error('memory_search requires query.');
  }

  const maxResultsRaw = Number(args.maxResults ?? DEFAULT_MAX_RESULTS);
  const maxResults = Number.isFinite(maxResultsRaw)
    ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(maxResultsRaw)))
    : DEFAULT_MAX_RESULTS;

  const minScoreRaw = Number(args.minScore ?? 0);
  const minScore = Number.isFinite(minScoreRaw) ? Math.max(0, Math.min(1, minScoreRaw)) : 0;

  const snippetLinesRaw = Number(args.snippetLines ?? DEFAULT_SNIPPET_LINES);
  const snippetLines = Number.isFinite(snippetLinesRaw)
    ? Math.max(1, Math.min(MAX_SNIPPET_LINES, Math.floor(snippetLinesRaw)))
    : DEFAULT_SNIPPET_LINES;

  const workspaceRoot = resolveWorkspaceRoot(context);
  const files = await collectMemoryFiles(workspaceRoot);
  const results: MemorySearchHit[] = [];
  const normalizedQuery = normalizeText(query);
  const tokens = tokenize(normalizedQuery);

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, 'utf8');
    const trimmedContent = raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw;
    const lines = trimmedContent.split('\n');
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || '';
      const normalizedLine = normalizeText(line);
      if (!normalizedLine) continue;

      const score = computeScore(normalizedLine, normalizedQuery, tokens);
      if (score <= 0 || score < minScore) continue;

      const startLine = Math.max(1, index + 1 - snippetLines + 1);
      const endLine = Math.min(lines.length, index + snippetLines);
      const snippet = lines
        .slice(startLine - 1, endLine)
        .join('\n')
        .trim();
      if (!snippet) continue;

      results.push({
        path: relativePath,
        startLine,
        endLine,
        score: Number(score.toFixed(4)),
        snippet,
      });
    }
  }

  results.sort((left, right) => {
    const byScore = right.score - left.score;
    if (byScore !== 0) return byScore;
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.startLine - right.startLine;
  });

  return {
    query,
    scannedFiles: files.length,
    results: dedupeResults(results).slice(0, maxResults),
  };
}

export async function memoryGetHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const requestedPath = String(args.path || '')
    .trim()
    .replace(/\\/g, '/');
  if (!requestedPath) {
    throw new Error('memory_get requires path.');
  }
  if (!isAllowedMemoryPath(requestedPath)) {
    throw new Error('memory_get only allows MEMORY.md and memory/*.md paths.');
  }

  const { resolvedPath, relativePath } = resolveWorkspacePath(requestedPath, context);
  const content = await fs.readFile(resolvedPath, 'utf8');
  const lines = content.split('\n');
  const fromRaw = Number(args.from ?? 1);
  const lineCountRaw = Number(args.lines ?? 40);
  const from = Number.isFinite(fromRaw) ? Math.max(1, Math.floor(fromRaw)) : 1;
  const lineCount = Number.isFinite(lineCountRaw)
    ? Math.max(1, Math.min(500, Math.floor(lineCountRaw)))
    : 40;
  const endLine = Math.min(lines.length, from + lineCount - 1);
  const text = lines.slice(from - 1, endLine).join('\n');

  return {
    path: relativePath,
    from,
    lines: lineCount,
    startLine: from,
    endLine,
    text,
  };
}

async function collectMemoryFiles(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  const memoryRoot = path.join(workspaceRoot, 'memory');
  const directMemoryFile = path.join(workspaceRoot, 'MEMORY.md');

  if (await exists(directMemoryFile)) {
    files.push(directMemoryFile);
  }

  if (!(await exists(memoryRoot))) {
    return files;
  }

  const stack = [memoryRoot];
  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isAllowedMemoryPath(relativePath: string): boolean {
  if (relativePath === 'MEMORY.md') return true;
  return relativePath.startsWith('memory/') && relativePath.toLowerCase().endsWith('.md');
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function computeScore(line: string, query: string, tokens: string[]): number {
  let score = 0;
  if (line.includes(query)) {
    score += 0.6;
  }
  if (tokens.length > 0) {
    let matched = 0;
    for (const token of tokens) {
      if (line.includes(token)) {
        matched += 1;
      }
    }
    score += (matched / tokens.length) * 0.4;
  }
  return Math.min(1, score);
}

function dedupeResults(results: MemorySearchHit[]): MemorySearchHit[] {
  const seen = new Set<string>();
  const deduped: MemorySearchHit[] = [];
  for (const entry of results) {
    const key = `${entry.path}:${entry.startLine}:${entry.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}
