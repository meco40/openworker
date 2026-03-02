import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import type { TaskDeliverable } from '@/lib/types';
import { extractAndValidateCss } from './cssValidation';
import type { CssValidationError, ResourceError, TestResult } from './types';

export const SCREENSHOTS_DIR =
  (process.env.PROJECTS_PATH || '~/projects').replace(/^~/, process.env.HOME || '') +
  '/.screenshots';

export function ensureScreenshotsDirExists(): void {
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export async function testDeliverable(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  deliverable: TaskDeliverable,
  taskId: string,
): Promise<TestResult> {
  const startTime = Date.now();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const resourceErrors: ResourceError[] = [];
  let cssErrors: CssValidationError[] = [];
  let httpStatus: number | null = null;
  let screenshotPath: string | null = null;

  const isUrlDeliverable = deliverable.deliverable_type === 'url';
  const testPath = deliverable.path || '';

  try {
    if (!isUrlDeliverable) {
      if (!testPath || !existsSync(testPath)) {
        return {
          passed: false,
          deliverable: {
            id: deliverable.id,
            title: deliverable.title,
            path: testPath || 'unknown',
            type: 'file',
          },
          httpStatus: null,
          consoleErrors: [`File does not exist: ${testPath}`],
          consoleWarnings: [],
          cssErrors: [],
          resourceErrors: [],
          screenshotPath: null,
          duration: Date.now() - startTime,
          error: 'File not found',
        };
      }

      if (!testPath.endsWith('.html') && !testPath.endsWith('.htm')) {
        return {
          passed: true,
          deliverable: {
            id: deliverable.id,
            title: deliverable.title,
            path: testPath,
            type: 'file',
          },
          httpStatus: null,
          consoleErrors: [],
          consoleWarnings: [],
          cssErrors: [],
          resourceErrors: [],
          screenshotPath: null,
          duration: Date.now() - startTime,
          error: 'Skipped - not an HTML file',
        };
      }

      const htmlContent = readFileSync(testPath, 'utf-8');
      cssErrors = extractAndValidateCss(htmlContent);
    }

    let testUrl: string;
    if (isUrlDeliverable) {
      if (isHttpUrl(testPath)) {
        testUrl = testPath;
      } else {
        if (!existsSync(testPath)) {
          return {
            passed: false,
            deliverable: {
              id: deliverable.id,
              title: deliverable.title,
              path: testPath,
              type: 'url',
            },
            httpStatus: null,
            consoleErrors: [`URL path does not exist: ${testPath}`],
            consoleWarnings: [],
            cssErrors: [],
            resourceErrors: [],
            screenshotPath: null,
            duration: Date.now() - startTime,
            error: 'Path not found',
          };
        }
        testUrl = `file://${testPath}`;
      }
    } else {
      testUrl = `file://${testPath}`;
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      } else if (msg.type() === 'warning') {
        consoleWarnings.push(msg.text());
      }
    });

    page.on('pageerror', (error) => {
      consoleErrors.push(`Page error: ${error.message}`);
    });

    page.on('requestfailed', (request) => {
      const url = request.url();
      const failure = request.failure();
      const resourceType = request.resourceType();

      let type: ResourceError['type'] = 'other';
      if (resourceType === 'image') type = 'image';
      else if (resourceType === 'script') type = 'script';
      else if (resourceType === 'stylesheet') type = 'stylesheet';
      else if (resourceType === 'document') type = 'link';

      resourceErrors.push({
        type,
        url,
        error: failure?.errorText || 'Request failed',
      });
    });

    const response = await page.goto(testUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    httpStatus = response?.status() || null;

    if (isHttpUrl(testUrl) && httpStatus && (httpStatus < 200 || httpStatus >= 400)) {
      consoleErrors.push(`HTTP error: Server returned status ${httpStatus}`);
    }

    await page.waitForTimeout(1000);

    const screenshotFilename = `${taskId}-${deliverable.id}-${Date.now()}.png`;
    screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFilename);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await context.close();

    const passed =
      consoleErrors.length === 0 && cssErrors.length === 0 && resourceErrors.length === 0;

    return {
      passed,
      deliverable: {
        id: deliverable.id,
        title: deliverable.title,
        path: testPath,
        type: isUrlDeliverable ? 'url' : 'file',
      },
      httpStatus,
      consoleErrors,
      consoleWarnings,
      cssErrors,
      resourceErrors,
      screenshotPath,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      passed: false,
      deliverable: {
        id: deliverable.id,
        title: deliverable.title,
        path: testPath || 'unknown',
        type: isUrlDeliverable ? 'url' : 'file',
      },
      httpStatus,
      consoleErrors: [...consoleErrors, `Test error: ${error}`],
      consoleWarnings,
      cssErrors,
      resourceErrors,
      screenshotPath,
      duration: Date.now() - startTime,
      error: String(error),
    };
  }
}
