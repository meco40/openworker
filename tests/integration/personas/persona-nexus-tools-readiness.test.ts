import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import { ToolManager } from '@/server/channels/messages/service/toolManager';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

const generateContentMock = vi.hoisted(() => vi.fn(async () => ({ text: 'vision-ok' })));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };
  },
}));

function buildConversation(): Conversation {
  return {
    id: 'conv-nexus-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-nexus',
    title: 'Nexus Tool Readiness',
    modelOverride: null,
    personaId: 'persona-nexus',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Persona Nexus tool readiness', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const previousSqlitePath = process.env.SQLITE_DB_PATH;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const previousApprovalsRequired = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;

  beforeAll(() => {
    const localDir = getTestArtifactsRoot();
    fs.mkdirSync(localDir, { recursive: true });
    const dbPath = path.join(localDir, 'nexus-tools-readiness.db');
    const db = new BetterSqlite3(dbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS readiness_notes (id INTEGER PRIMARY KEY, title TEXT); DELETE FROM readiness_notes; INSERT INTO readiness_notes(title) VALUES ('nexus-ok');",
    );
    db.close();

    process.env.SQLITE_DB_PATH = dbPath;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'false';
  });

  beforeEach(() => {
    generateContentMock.mockClear();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('example.com')) {
        return new Response(
          '<html><head><title>Nexus Example</title><meta name="description" content="nexus-desc"></head><body>hello nexus</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }

      if (url.includes('api.github.com/repos/vercel/next.js')) {
        return new Response(
          JSON.stringify({
            full_name: 'vercel/next.js',
            description: 'The React Framework',
            stargazers_count: 1,
            forks_count: 1,
            open_issues_count: 1,
            html_url: 'https://github.com/vercel/next.js',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('not-found', { status: 404 });
    });
  });

  it('executes all runtime tools including multi_tool_use.parallel', async () => {
    const manager = new ToolManager(
      () => false,
      async () => ({
        status: 'ok',
        action: 'list',
        text: 'Subagents\n\nactive:\n(none)',
      }),
    );
    const conversation = buildConversation();
    const installedFunctions = new Set([
      'shell_execute',
      'file_read',
      'python_execute',
      'browser_snapshot',
      'vision_analyze',
      'db_query',
      'github_query',
      'subagents',
      'multi_tool_use.parallel',
    ]);

    const shellResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'shell_execute',
      args: { command: 'echo nexus-smoke' },
      installedFunctions,
    });
    expect(shellResult.kind).toBe('ok');

    const fileReadResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'file_read',
      args: { path: 'README.md' },
      installedFunctions,
    });
    expect(fileReadResult.kind).toBe('ok');

    const pythonResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'python_execute',
      args: { code: 'print(7)' },
      installedFunctions,
    });
    expect(pythonResult.kind).toBe('ok');

    const browserResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'browser_snapshot',
      args: { url: 'https://example.com' },
      installedFunctions,
    });
    expect(browserResult.kind).toBe('ok');
    if (browserResult.kind === 'ok') {
      expect(browserResult.output).toContain('Nexus Example');
    }

    const visionResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'vision_analyze',
      args: { imageBase64: 'aGVsbG8=', mimeType: 'image/png' },
      installedFunctions,
    });
    expect(visionResult.kind).toBe('ok');
    if (visionResult.kind === 'ok') {
      expect(visionResult.output).toContain('vision-ok');
    }

    const dbResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'db_query',
      args: { query: 'select id, title from readiness_notes order by id' },
      installedFunctions,
    });
    expect(dbResult.kind).toBe('ok');
    if (dbResult.kind === 'ok') {
      expect(dbResult.output).toContain('nexus-ok');
    }

    const githubResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'github_query',
      args: { repo: 'vercel/next.js', action: 'repo_info' },
      installedFunctions,
    });
    expect(githubResult.kind).toBe('ok');
    if (githubResult.kind === 'ok') {
      expect(githubResult.output).toContain('vercel/next.js');
    }

    const subagentsResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'subagents',
      args: { action: 'list' },
      installedFunctions,
    });
    expect(subagentsResult.kind).toBe('ok');
    if (subagentsResult.kind === 'ok') {
      expect(subagentsResult.output).toContain('Subagents');
    }

    const parallelWrapperResult = await manager.executeToolFunctionCall({
      conversation,
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
      functionName: 'multi_tool_use.parallel',
      args: {
        tool_uses: [
          {
            recipient_name: 'functions.shell_execute',
            parameters: { command: 'echo parallel-nexus' },
          },
          {
            name: 'file_read',
            args: { path: 'README.md' },
          },
        ],
      },
      installedFunctions,
    });
    expect(parallelWrapperResult.kind).toBe('ok');
    if (parallelWrapperResult.kind === 'ok') {
      expect(parallelWrapperResult.output).toContain('"status": "ok"');
      expect(parallelWrapperResult.output).toContain('"successCount": 2');
      expect(parallelWrapperResult.output).toContain('parallel-nexus');
    }

    expect(fetchSpy).toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    if (previousSqlitePath === undefined) {
      delete process.env.SQLITE_DB_PATH;
    } else {
      process.env.SQLITE_DB_PATH = previousSqlitePath;
    }
    if (previousGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = previousGeminiKey;
    }
    if (previousApprovalsRequired === undefined) {
      delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    } else {
      process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previousApprovalsRequired;
    }
  });
});
