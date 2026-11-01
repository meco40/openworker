import fs from 'node:fs';
import path from 'node:path';
// The classic compiler API; TypeScript 7 (the project compiler) no longer exports it.
import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

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
  it('prevents forbidden import directions', () => {
    const sharedFiles = collectFiles(path.resolve(ROOT, 'src/shared'));
    const uiFiles = [...collectFiles(path.resolve(ROOT, 'src/modules/chat'))];
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
