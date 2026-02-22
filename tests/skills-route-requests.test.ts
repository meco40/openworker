import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as executeSkillPost } from '../app/api/skills/execute/route';

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/skills/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('skills execute route requests', () => {
  beforeAll(() => {
    const localDir = path.join(process.cwd(), '.local');
    fs.mkdirSync(localDir, { recursive: true });
    const dbPath = path.join(localDir, 'skills.db');
    process.env.SQLITE_DB_PATH = '.local/skills.db';

    const db = new BetterSqlite3(dbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT); DELETE FROM notes; INSERT INTO notes(title) VALUES ('alpha'),('beta');",
    );
    db.close();
  });

  it('handles file_read request', async () => {
    const response = await executeSkillPost(
      makeRequest({ name: 'file_read', args: { path: 'README.md' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.result.content).toBe('string');
  });

  it('handles shell_execute request', async () => {
    const response = await executeSkillPost(
      makeRequest({ name: 'shell_execute', args: { command: 'pwd' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.result.exitCode).toBe('number');
  });

  it('handles python_execute request', async () => {
    const response = await executeSkillPost(
      makeRequest({ name: 'python_execute', args: { code: 'print(1+1)' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.result.exitCode).toBe('number');
  });

  it('handles db_query request', async () => {
    const response = await executeSkillPost(
      makeRequest({ name: 'db_query', args: { query: 'select id, title from notes order by id' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.result.rows)).toBe(true);
    expect(json.result.rows.length).toBeGreaterThan(0);
  });

  it('handles browser_snapshot request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><head><title>Example</title></head><body>Hello world</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const response = await executeSkillPost(
      makeRequest({ name: 'browser_snapshot', args: { url: 'https://example.com' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.result.title).toBe('Example');
    fetchMock.mockRestore();
  });

  it('handles github_query request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          full_name: 'vercel/next.js',
          description: 'The React Framework',
          stargazers_count: 1,
          forks_count: 1,
          open_issues_count: 1,
          html_url: 'https://github.com/vercel/next.js',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await executeSkillPost(
      makeRequest({ name: 'github_query', args: { repo: 'vercel/next.js', action: 'repo_info' } }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.result.full_name).toBe('vercel/next.js');
    fetchMock.mockRestore();
  });

  it('handles vision_analyze request (validation)', async () => {
    const response = await executeSkillPost(makeRequest({ name: 'vision_analyze', args: {} }));
    const json = await response.json();
    expect(response.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('vision_analyze requires imageBase64 or imageUrl');
  });

  it('handles multi_tool_use.parallel request', async () => {
    const response = await executeSkillPost(
      makeRequest({
        name: 'multi_tool_use.parallel',
        args: {
          tool_uses: [
            { recipient_name: 'functions.shell_execute', parameters: { command: 'echo route-par' } },
            { name: 'file_read', args: { path: 'README.md' } },
          ],
        },
      }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.result.status).toBe('ok');
    expect(json.result.successCount).toBe(2);
    expect(json.result.failureCount).toBe(0);
  });
});
