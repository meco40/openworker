import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LEGACY_ROUTE_DB_EXCEPTIONS = new Set([
  'app/api/agents/[id]/openclaw/route.ts',
  'app/api/agents/[id]/route.ts',
  'app/api/agents/discover/route.ts',
  'app/api/agents/import/route.ts',
  'app/api/agents/route.ts',
  'app/api/events/route.ts',
  'app/api/openclaw/sessions/[id]/route.ts',
  'app/api/openclaw/sessions/route.ts',
  'app/api/tasks/[id]/activities/route.ts',
  'app/api/tasks/[id]/deliverables/route.ts',
  'app/api/tasks/[id]/planning/answer/route.ts',
  'app/api/tasks/[id]/planning/poll/route.ts',
  'app/api/tasks/[id]/planning/retry-dispatch/route.ts',
  'app/api/tasks/[id]/planning/route.ts',
  'app/api/tasks/[id]/subagent/route.ts',
  'app/api/webhooks/agent-completion/route.ts',
  'app/api/workspaces/[id]/route.ts',
  'app/api/workspaces/route.ts',
]);

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
    files.push(full);
  }
  return files;
}

function parseSource(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('AST architecture guards', () => {
  it('keeps app/api routes thin (legacy db-backed routes are explicitly frozen)', () => {
    const routeFiles = collectFiles(path.resolve(ROOT, 'app/api')).filter((filePath) =>
      filePath.endsWith(`${path.sep}route.ts`),
    );
    const violations: string[] = [];
    const baselineExceptions = new Set<string>();

    for (const filePath of routeFiles) {
      const source = parseSource(filePath);
      const relativePath = path.relative(ROOT, filePath).replace(/\\/g, '/');
      let hasDirectDbCall = false;
      walk(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        const expressionText = node.expression.getText(source);
        if (
          expressionText === 'queryAll' ||
          expressionText === 'queryOne' ||
          expressionText === 'run' ||
          expressionText === 'getDb'
        ) {
          hasDirectDbCall = true;
        }
      });

      if (!hasDirectDbCall) continue;
      if (LEGACY_ROUTE_DB_EXCEPTIONS.has(relativePath)) {
        baselineExceptions.add(relativePath);
        continue;
      }
      violations.push(relativePath);
    }

    expect(new Set([...baselineExceptions])).toEqual(LEGACY_ROUTE_DB_EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('prevents forbidden import directions', () => {
    const sharedFiles = collectFiles(path.resolve(ROOT, 'src/shared'));
    const uiFiles = [
      ...collectFiles(path.resolve(ROOT, 'src/modules/chat')),
      ...collectFiles(path.resolve(ROOT, 'src/modules/mission-control')),
    ];
    const violations: string[] = [];

    for (const filePath of sharedFiles) {
      const source = parseSource(filePath);
      walk(source, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        const importPath = String((node.moduleSpecifier as ts.StringLiteral).text || '');
        if (importPath.startsWith('@/server/') || importPath.startsWith('@/modules/')) {
          violations.push(`${path.relative(ROOT, filePath)} -> ${importPath}`);
        }
      });
    }

    for (const filePath of uiFiles) {
      const source = parseSource(filePath);
      walk(source, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        const importPath = String((node.moduleSpecifier as ts.StringLiteral).text || '');
        if (importPath.startsWith('@/server/')) {
          violations.push(`${path.relative(ROOT, filePath)} -> ${importPath}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
