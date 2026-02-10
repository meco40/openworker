import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { GoogleGenAI } from '@google/genai';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 256_000;
const MAX_RESULT_ROWS = 200;

interface SkillRequest {
  name: string;
  args?: Record<string, unknown>;
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function ensureWorkspacePath(userPath: string): string {
  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('Path escapes workspace root.');
  }
  return resolved;
}

function getServerGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!key) throw new Error('Missing GEMINI_API_KEY on server.');
  return key;
}

async function executeFileRead(args: Record<string, unknown>) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) throw new Error('file_read requires a non-empty path.');
  const resolvedPath = ensureWorkspacePath(inputPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constrained via ensureWorkspacePath.
  const content = await readFile(resolvedPath, 'utf-8');
  const truncated = content.length > MAX_FILE_BYTES;
  return {
    path: inputPath,
    resolvedPath,
    truncated,
    content: truncated ? content.slice(0, MAX_FILE_BYTES) : content,
  };
}

async function executeShell(args: Record<string, unknown>) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('shell_execute requires command.');
  const blocked = /(rm\s+-rf|del\s+\/f|shutdown|reboot|mkfs|format\s+[a-z]:|:\(\)\s*\{\s*:\|:&\s*\};:|dd\s+if=|cipher\s+\/w)/i;
  if (blocked.test(command)) {
    throw new Error('Command blocked by security policy.');
  }

  try {
    const { stdout, stderr } = await execFile(
      'powershell',
      ['-NoProfile', '-Command', command],
      { cwd: process.cwd(), timeout: 15_000, maxBuffer: 1_000_000 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typed.stdout || '',
      stderr: typed.stderr || String(error),
      exitCode: typed.code ?? 1,
    };
  }
}

async function executePython(args: Record<string, unknown>) {
  const code = String(args.code || '').trim();
  if (!code) throw new Error('python_execute requires code.');

  try {
    const { stdout, stderr } = await execFile(
      'python',
      ['-c', code],
      { cwd: process.cwd(), timeout: 20_000, maxBuffer: 1_000_000 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typed.stdout || '',
      stderr: typed.stderr || 'Python execution failed.',
      exitCode: typed.code ?? 1,
    };
  }
}

async function executeGithubQuery(args: Record<string, unknown>) {
  const repo = String(args.repo || '').trim();
  const action = String(args.action || '').trim();
  const query = String(args.query || '').trim();
  if (!repo || !action) throw new Error('github_query requires repo and action.');

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'openclaw-gateway',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let url = '';
  if (action === 'repo_info') {
    url = `https://api.github.com/repos/${repo}`;
  } else if (action === 'list_issues') {
    url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=20`;
  } else if (action === 'list_pulls') {
    url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=20`;
  } else if (action === 'search_code') {
    if (!query) throw new Error('search_code requires query.');
    url = `https://api.github.com/search/code?q=${encodeURIComponent(`${query} repo:${repo}`)}&per_page=20`;
  } else {
    throw new Error(`Unsupported github action: ${action}`);
  }

  const response = await fetch(url, { headers });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${JSON.stringify(data)}`);
  }

  if (action === 'repo_info') {
    return {
      full_name: data.full_name,
      description: data.description,
      stars: data.stargazers_count,
      forks: data.forks_count,
      open_issues: data.open_issues_count,
      url: data.html_url,
    };
  }

  if (action === 'list_issues') {
    const issues = (data as Array<any>)
      .filter((item) => !item.pull_request)
      .map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
      }));
    return { count: issues.length, issues };
  }

  if (action === 'list_pulls') {
    const pulls = (data as Array<any>).map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
    }));
    return { count: pulls.length, pulls };
  }

  const items = ((data.items || []) as Array<any>).map((item) => ({
    name: item.name,
    path: item.path,
    repo: item.repository?.full_name,
    url: item.html_url,
  }));
  return { total_count: data.total_count || 0, items };
}

async function executeDbQuery(args: Record<string, unknown>) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('db_query requires query.');
  if (!/^(select|with|pragma|explain)\b/i.test(query)) {
    throw new Error('Only read-only SQL statements are allowed.');
  }

  const dbPath = process.env.SQLITE_DB_PATH;
  if (!dbPath) {
    throw new Error('SQLITE_DB_PATH is not configured.');
  }

  const resolved = ensureWorkspacePath(dbPath);
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    const statement = db.prepare(query);
    const rows = statement.all();
    return {
      rowCount: rows.length,
      rows: rows.slice(0, MAX_RESULT_ROWS),
      truncated: rows.length > MAX_RESULT_ROWS,
    };
  } finally {
    db.close();
  }
}

async function executeBrowserSnapshot(args: Record<string, unknown>) {
  const url = String(args.url || '').trim() || 'https://example.com';
  const response = await fetch(url, { headers: { 'User-Agent': 'openclaw-browser-skill' } });
  if (!response.ok) throw new Error(`Failed to fetch URL (${response.status}).`);
  const html = await response.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descriptionMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );
  const plainText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    url,
    status: response.status,
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descriptionMatch ? descriptionMatch[1].trim() : '',
    excerpt: plainText.slice(0, 800),
    fetchedAt: new Date().toISOString(),
  };
}

async function executeVisionAnalyze(args: Record<string, unknown>) {
  const imageUrl = String(args.imageUrl || '').trim();
  const imageBase64 = String(args.imageBase64 || '').trim();
  const focus = String(args.focus || '').trim() || 'Describe the image, important objects, and any visible text.';
  const mimeType = String(args.mimeType || 'image/png').trim();

  let data = imageBase64;
  let effectiveMime = mimeType;

  if (!data && imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Unable to download image (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    data = Buffer.from(bytes).toString('base64');
    effectiveMime = response.headers.get('content-type') || mimeType;
  }

  if (!data) {
    throw new Error('vision_analyze requires imageBase64 or imageUrl.');
  }

  const ai = new GoogleGenAI({ apiKey: getServerGeminiKey() });
  const result = await (ai.models as any).generateContent({
    model: 'gemini-2.5-flash-latest',
    contents: [
      {
        role: 'user',
        parts: [
          { text: focus },
          { inlineData: { mimeType: effectiveMime, data } },
        ],
      },
    ],
  });

  return {
    analysis: result?.text || '',
    mimeType: effectiveMime,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SkillRequest;
    const args = normalizeArgs(body.args);

    let result: unknown;
    if (body.name === 'file_read') {
      result = await executeFileRead(args);
    } else if (body.name === 'shell_execute') {
      result = await executeShell(args);
    } else if (body.name === 'python_execute') {
      result = await executePython(args);
    } else if (body.name === 'github_query') {
      result = await executeGithubQuery(args);
    } else if (body.name === 'db_query') {
      result = await executeDbQuery(args);
    } else if (body.name === 'browser_snapshot') {
      result = await executeBrowserSnapshot(args);
    } else if (body.name === 'vision_analyze') {
      result = await executeVisionAnalyze(args);
    } else {
      return NextResponse.json({ error: `Unsupported skill: ${body.name}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown skill execution error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
