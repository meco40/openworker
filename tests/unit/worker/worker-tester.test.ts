import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWebappTests } from '../../../src/server/worker/workerTester';

describe('WorkerTester — runWebappTests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFile = (relativePath: string, content: string) => {
    const fullPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };

  it('fails when output directory is missing', () => {
    const result = runWebappTests(tmpDir);
    expect(result.passed).toBe(false);
    expect(result.results[0].name).toBe('Output-Verzeichnis existiert');
    expect(result.results[0].passed).toBe(false);
  });

  it('fails when no HTML files exist', () => {
    fs.mkdirSync(path.join(tmpDir, 'output'));
    const result = runWebappTests(tmpDir);
    expect(result.passed).toBe(false);
    const htmlCheck = result.results.find((r) => r.name === 'HTML-Dateien vorhanden');
    expect(htmlCheck?.passed).toBe(false);
  });

  it('passes for a valid HTML file', () => {
    const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Test App</title>
</head>
<body>
  <main>
    <h1>Hello World</h1>
    <p>This is a test page with enough content to pass validation.</p>
  </main>
</body>
</html>`;
    writeFile('output/index.html', html);

    const result = runWebappTests(tmpDir);
    const failedTests = result.results.filter((r) => !r.passed);
    expect(failedTests).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('detects missing DOCTYPE', () => {
    const html = `<html><head><meta charset="UTF-8"><title>No doctype</title></head><body><p>Test content that is long enough to pass the length check for this test case</p></body></html>`;
    writeFile('output/index.html', html);

    const result = runWebappTests(tmpDir);
    const doctypeTest = result.results.find((r) => r.name.includes('DOCTYPE'));
    expect(doctypeTest?.passed).toBe(false);
  });

  it('detects missing title tag', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><p>Test content that is long enough to pass the length check for this particular test case</p></body></html>`;
    writeFile('output/index.html', html);

    const result = runWebappTests(tmpDir);
    const titleTest = result.results.find((r) => r.name.includes('<title>'));
    expect(titleTest?.passed).toBe(false);
  });

  it('validates CSS files', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><p>Test content that is long enough to pass validation checks in the tester module</p></body></html>`;
    const css = `
body {
  margin: 0;
  font-family: sans-serif;
}

.container {
  max-width: 800px;
  margin: 0 auto;
}`;
    writeFile('output/index.html', html);
    writeFile('output/style.css', css);

    const result = runWebappTests(tmpDir);
    const cssTests = result.results.filter((r) => r.name.includes('.css'));
    expect(cssTests.length).toBeGreaterThan(0);
    expect(cssTests.every((t) => t.passed)).toBe(true);
  });

  it('detects unbalanced CSS braces', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test</title></head><body><p>Test content that is long enough to pass validation checks in this test case</p></body></html>`;
    const css = `
body {
  margin: 0;

.container {
  max-width: 800px;
}`;
    writeFile('output/index.html', html);
    writeFile('output/broken.css', css);

    const result = runWebappTests(tmpDir);
    const braceTest = result.results.find((r) => r.name.includes('Klammern'));
    expect(braceTest?.passed).toBe(false);
  });

  it('returns correct total and failed counts', () => {
    const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Test</title>
</head>
<body>
  <p>This is a properly structured test page with all required elements present.</p>
</body>
</html>`;
    writeFile('output/index.html', html);

    const result = runWebappTests(tmpDir);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBe(result.results.length);
    expect(result.failed).toBe(result.results.filter((r) => !r.passed).length);
  });
});
