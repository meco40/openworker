/**
 * pdf_generate handler — Convert HTML or Markdown content to a PDF file.
 * Saves to {workspaceCwd}/output/<filename>.pdf
 * Uses headless Chromium/Chrome if available, otherwise wkhtmltopdf, otherwise saves as HTML.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { SkillDispatchContext } from '@/server/skills/types';

const DEFAULT_OUTPUT_DIR = '.local/pdf-output';

function ensureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function formatInlineMarkdown(content: string): string {
  return content
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    output.push('<ul>', ...listBuffer, '</ul>');
    listBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith('- ')) {
      listBuffer.push(`<li>${formatInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    flushList();
    if (line.startsWith('### ')) {
      output.push(`<h3>${formatInlineMarkdown(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      output.push(`<h2>${formatInlineMarkdown(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      output.push(`<h1>${formatInlineMarkdown(line.slice(2))}</h1>`);
      continue;
    }
    output.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  flushList();
  return output.join('\n');
}

function wrapInHtmlPage(content: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
  h1, h2, h3 { color: #111; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
  ul, ol { margin: 0 0 1em; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

function findChromiumExecutable(): string | null {
  const candidates = [
    'chromium-browser',
    'chromium',
    'google-chrome',
    'google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    try {
      execSync(
        process.platform === 'win32'
          ? `where "${candidate}" 2>nul`
          : `which "${candidate}" 2>/dev/null`,
        { stdio: 'pipe' },
      );
      return candidate;
    } catch {
      // not found
    }
  }
  return null;
}

export async function pdfGenerateHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const content = String(args.content || args.html || args.markdown || '').trim();
  if (!content) return { error: 'content (or html / markdown) is required' };

  const filename = String(args.filename || 'document')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/\.pdf$/i, '');

  const outputDir = context?.workspaceCwd
    ? path.join(context.workspaceCwd, 'output')
    : DEFAULT_OUTPUT_DIR;
  ensureOutputDir(outputDir);

  // Detect if input is markdown or HTML
  const isHtml = /<[a-z][\s\S]*>/i.test(content);
  const htmlContent = isHtml ? content : markdownToHtml(content);
  const fullHtml = wrapInHtmlPage(htmlContent, filename);

  const htmlPath = path.join(outputDir, `${filename}.html`);
  const pdfPath = path.join(outputDir, `${filename}.pdf`);

  fs.writeFileSync(htmlPath, fullHtml, 'utf-8');

  // Try headless Chrome
  const chromium = findChromiumExecutable();
  if (chromium) {
    try {
      execSync(
        `"${chromium}" --headless --disable-gpu --no-sandbox --print-to-pdf="${pdfPath}" "${htmlPath}"`,
        { timeout: 30_000, stdio: 'pipe' },
      );
      return {
        status: 'ok',
        method: 'chromium',
        pdfPath,
        htmlPath,
        message: `PDF generated at ${pdfPath}`,
      };
    } catch {
      // fall through to wkhtmltopdf
    }
  }

  // Try wkhtmltopdf
  try {
    execSync(`wkhtmltopdf "${htmlPath}" "${pdfPath}"`, { timeout: 30_000, stdio: 'pipe' });
    return {
      status: 'ok',
      method: 'wkhtmltopdf',
      pdfPath,
      htmlPath,
      message: `PDF generated at ${pdfPath}`,
    };
  } catch {
    // fall through
  }

  // No PDF converter available — return the HTML file
  return {
    status: 'html_only',
    method: 'none',
    htmlPath,
    message: `No PDF converter (chromium/wkhtmltopdf) found. HTML saved at ${htmlPath}. Use shell_execute to convert manually or install a PDF converter.`,
  };
}
