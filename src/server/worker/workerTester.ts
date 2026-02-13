// ─── Worker Tester ───────────────────────────────────────────
// Node.js-based automated testing for webapp tasks.
// Validates HTML structure and CSS syntax without external dependencies.

import fs from 'node:fs';
import path from 'node:path';

export interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

export interface TestSuiteResult {
  passed: boolean;
  total: number;
  failed: number;
  results: TestResult[];
}

/**
 * Run automated tests on a webapp workspace.
 * Checks: file existence, HTML validity, CSS syntax basics.
 */
export function runWebappTests(workspacePath: string): TestSuiteResult {
  const results: TestResult[] = [];

  // ─── 1. Check required files exist ──────────────────────
  const outputDir = path.join(workspacePath, 'output');
  const hasOutputDir = fs.existsSync(outputDir);

  results.push({
    name: 'Output-Verzeichnis existiert',
    passed: hasOutputDir,
    message: hasOutputDir ? 'output/ Verzeichnis gefunden' : 'output/ Verzeichnis fehlt',
  });

  if (!hasOutputDir) {
    return summarize(results);
  }

  // Find HTML files
  const allFiles = listFilesRecursive(outputDir);
  const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));
  const cssFiles = allFiles.filter((f) => f.endsWith('.css'));

  results.push({
    name: 'HTML-Dateien vorhanden',
    passed: htmlFiles.length > 0,
    message: htmlFiles.length > 0
      ? `${htmlFiles.length} HTML-Datei(en) gefunden`
      : 'Keine HTML-Dateien im Output gefunden',
  });

  // ─── 2. Validate HTML files ─────────────────────────────
  for (const htmlFile of htmlFiles) {
    const relativePath = path.relative(workspacePath, htmlFile);
    const content = fs.readFileSync(htmlFile, 'utf-8');
    const htmlResults = validateHTML(content, relativePath);
    results.push(...htmlResults);
  }

  // ─── 3. Validate CSS files ──────────────────────────────
  for (const cssFile of cssFiles) {
    const relativePath = path.relative(workspacePath, cssFile);
    const content = fs.readFileSync(cssFile, 'utf-8');
    const cssResults = validateCSS(content, relativePath);
    results.push(...cssResults);
  }

  return summarize(results);
}

// ─── HTML Validation ──────────────────────────────────────────

function validateHTML(content: string, filePath: string): TestResult[] {
  const results: TestResult[] = [];

  // Check DOCTYPE
  const hasDoctype = /<!doctype\s+html>/i.test(content);
  results.push({
    name: `${filePath}: DOCTYPE`,
    passed: hasDoctype,
    message: hasDoctype ? 'DOCTYPE vorhanden' : 'DOCTYPE fehlt',
  });

  // Check <html> tag
  const hasHtml = /<html[\s>]/i.test(content) && /<\/html>/i.test(content);
  results.push({
    name: `${filePath}: <html> Tag`,
    passed: hasHtml,
    message: hasHtml ? '<html> Tag korrekt' : '<html> Tag fehlt oder nicht geschlossen',
  });

  // Check <head> tag
  const hasHead = /<head[\s>]/i.test(content) && /<\/head>/i.test(content);
  results.push({
    name: `${filePath}: <head> Tag`,
    passed: hasHead,
    message: hasHead ? '<head> Tag korrekt' : '<head> Tag fehlt oder nicht geschlossen',
  });

  // Check <body> tag
  const hasBody = /<body[\s>]/i.test(content) && /<\/body>/i.test(content);
  results.push({
    name: `${filePath}: <body> Tag`,
    passed: hasBody,
    message: hasBody ? '<body> Tag korrekt' : '<body> Tag fehlt oder nicht geschlossen',
  });

  // Check <title> tag
  const hasTitle = /<title>[\s\S]*?<\/title>/i.test(content);
  results.push({
    name: `${filePath}: <title> Tag`,
    passed: hasTitle,
    message: hasTitle ? '<title> Tag vorhanden' : '<title> Tag fehlt',
  });

  // Check for unclosed common tags
  const tagPairs: Array<[string, RegExp, RegExp]> = [
    ['div', /<div[\s>]/gi, /<\/div>/gi],
    ['p', /<p[\s>]/gi, /<\/p>/gi],
    ['span', /<span[\s>]/gi, /<\/span>/gi],
    ['section', /<section[\s>]/gi, /<\/section>/gi],
    ['main', /<main[\s>]/gi, /<\/main>/gi],
  ];

  for (const [tag, openRe, closeRe] of tagPairs) {
    const opens = (content.match(openRe) || []).length;
    const closes = (content.match(closeRe) || []).length;
    if (opens > 0 && opens !== closes) {
      results.push({
        name: `${filePath}: <${tag}> Balance`,
        passed: false,
        message: `<${tag}>: ${opens} geöffnet, ${closes} geschlossen`,
      });
    }
  }

  // Check charset meta
  const hasCharset = /charset\s*=\s*["']?utf-8/i.test(content);
  results.push({
    name: `${filePath}: Charset`,
    passed: hasCharset,
    message: hasCharset ? 'UTF-8 Charset deklariert' : 'UTF-8 Charset fehlt',
  });

  // File is not empty
  const nonEmpty = content.trim().length > 50;
  results.push({
    name: `${filePath}: Inhalt vorhanden`,
    passed: nonEmpty,
    message: nonEmpty ? `${content.length} Zeichen` : 'Datei ist leer oder zu kurz',
  });

  return results;
}

// ─── CSS Validation ───────────────────────────────────────────

function validateCSS(content: string, filePath: string): TestResult[] {
  const results: TestResult[] = [];

  // Non-empty
  const nonEmpty = content.trim().length > 10;
  results.push({
    name: `${filePath}: Inhalt vorhanden`,
    passed: nonEmpty,
    message: nonEmpty ? `${content.length} Zeichen` : 'CSS-Datei ist leer oder zu kurz',
  });

  if (!nonEmpty) return results;

  // Check balanced curly braces
  const opens = (content.match(/\{/g) || []).length;
  const closes = (content.match(/\}/g) || []).length;
  const balanced = opens === closes;
  results.push({
    name: `${filePath}: Klammern balanciert`,
    passed: balanced,
    message: balanced ? `${opens} Blöcke korrekt` : `{ = ${opens}, } = ${closes} — nicht balanciert`,
  });

  // Check for common CSS errors — double semicolons
  const doubleSemicolon = /;;/g.test(content);
  results.push({
    name: `${filePath}: Keine doppelten Semikolons`,
    passed: !doubleSemicolon,
    message: doubleSemicolon ? 'Doppelte Semikolons gefunden' : 'OK',
  });

  // Check for at least one rule
  const hasRules = /[.#a-z@][^{]*\{[^}]*\}/i.test(content);
  results.push({
    name: `${filePath}: CSS-Regeln vorhanden`,
    passed: hasRules,
    message: hasRules ? 'CSS-Regeln erkannt' : 'Keine CSS-Regeln erkannt',
  });

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory not accessible
  }
  return results;
}

function summarize(results: TestResult[]): TestSuiteResult {
  const failed = results.filter((r) => !r.passed).length;
  return {
    passed: failed === 0,
    total: results.length,
    failed,
    results,
  };
}
