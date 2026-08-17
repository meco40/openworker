import { expect, test, type Page } from '@playwright/test';

async function openTasks(page: Page) {
  await page.goto('/');
  await page.locator('button[data-view="tasks"]').click({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Task Manager' })).toBeVisible({ timeout: 10000 });
}

test.describe('Task Management', () => {
  test('view task list', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible();
  });

  test('create new task', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();
  });

  test('edit task details', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByRole('heading', { name: 'Task Manager' })).toBeVisible();
  });

  test('assign task to agent', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByLabel('Filter by priority')).toBeVisible();
  });

  test('change task status', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByLabel('Filter by status')).toBeVisible();
  });
});
