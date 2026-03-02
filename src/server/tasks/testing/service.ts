import { NextResponse } from 'next/server';
import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Task, TaskDeliverable } from '@/lib/types';
import { ensureScreenshotsDirExists, testDeliverable } from './deliverableTester';
import type { TestResponse, TestResult } from './types';

export async function runTaskTests(taskId: string): Promise<NextResponse> {
  try {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const deliverables = queryAll<TaskDeliverable>(
      'SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)',
      [taskId, 'file', 'url'],
    );

    if (deliverables.length === 0) {
      return NextResponse.json(
        { error: 'No testable deliverables found (file or url types)' },
        { status: 400 },
      );
    }

    ensureScreenshotsDirExists();

    const browser = await chromium.launch({ headless: true });
    const results: TestResult[] = [];

    try {
      for (const deliverable of deliverables) {
        const result = await testDeliverable(browser, deliverable, taskId);
        results.push(result);
      }
    } finally {
      await browser.close();
    }

    const passed = results.every((result) => result.passed);
    const failedCount = results.filter((result) => !result.passed).length;

    let summary: string;
    if (passed) {
      summary = `All ${results.length} deliverable(s) passed automated testing. No console errors, CSS errors, or broken resources detected.`;
    } else {
      const issues: string[] = [];
      for (const result of results.filter((entry) => !entry.passed)) {
        const errorTypes: string[] = [];
        if (result.consoleErrors.length > 0)
          errorTypes.push(`${result.consoleErrors.length} JS errors`);
        if (result.cssErrors.length > 0) errorTypes.push(`${result.cssErrors.length} CSS errors`);
        if (result.resourceErrors.length > 0) {
          errorTypes.push(`${result.resourceErrors.length} broken resources`);
        }
        issues.push(`${result.deliverable.title}: ${errorTypes.join(', ')}`);
      }
      summary = `${failedCount}/${results.length} deliverable(s) failed. Issues: ${issues.join('; ')}`;
    }

    const activityMessage = passed
      ? `Automated test passed - ${results.length} deliverable(s) verified, no issues found`
      : `Automated test failed - ${summary}`;

    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        taskId,
        passed ? 'test_passed' : 'test_failed',
        activityMessage,
        JSON.stringify({
          results: results.map((result) => ({
            deliverable: result.deliverable.title,
            type: result.deliverable.type,
            passed: result.passed,
            consoleErrors: result.consoleErrors.length,
            cssErrors: result.cssErrors.length,
            resourceErrors: result.resourceErrors.length,
            screenshot: result.screenshotPath,
          })),
        }),
        new Date().toISOString(),
      ],
    );

    const now = new Date().toISOString();
    let newStatus: string | undefined;

    if (passed) {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['review', now, taskId]);
      newStatus = 'review';

      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          'status_changed',
          'Task moved to REVIEW - automated tests passed, awaiting human approval',
          now,
        ],
      );
    } else {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['assigned', now, taskId]);
      newStatus = 'assigned';

      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          'status_changed',
          'Task moved back to ASSIGNED due to failed automated tests - agent needs to fix issues',
          now,
        ],
      );
    }

    const response: TestResponse = {
      taskId,
      taskTitle: task.title,
      passed,
      results,
      summary,
      testedAt: new Date().toISOString(),
      newStatus,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Test execution error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export function getTaskTestInfo(taskId: string): NextResponse {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const deliverables = queryAll<TaskDeliverable>(
    'SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)',
    [taskId, 'file', 'url'],
  );

  const fileDeliverables = deliverables.filter(
    (deliverable) => deliverable.deliverable_type === 'file',
  );
  const urlDeliverables = deliverables.filter(
    (deliverable) => deliverable.deliverable_type === 'url',
  );

  return NextResponse.json({
    taskId,
    taskTitle: task.title,
    taskStatus: task.status,
    deliverableCount: deliverables.length,
    testableFiles: fileDeliverables
      .filter(
        (deliverable) => deliverable.path?.endsWith('.html') || deliverable.path?.endsWith('.htm'),
      )
      .map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        path: deliverable.path,
      })),
    testableUrls: urlDeliverables.map((deliverable) => ({
      id: deliverable.id,
      title: deliverable.title,
      path: deliverable.path,
    })),
    validations: [
      'JavaScript console error detection',
      'CSS syntax validation (via css-tree)',
      'Resource loading validation (images, scripts, stylesheets)',
      'HTTP status code validation (for URL deliverables)',
    ],
    workflow: {
      expectedStatus: 'testing',
      onPass: 'Moves to review for human approval',
      onFail: 'Moves to assigned for agent to fix issues',
    },
    usage: {
      method: 'POST',
      description: 'Run automated browser tests on all HTML/URL deliverables',
      returns:
        'Test results with pass/fail, console errors, CSS errors, resource errors, and screenshots',
    },
  });
}
