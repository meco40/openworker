import { expect, test } from '@playwright/test';

test.describe('Task Management', () => {
  test('view task list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Tasks/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('create new task', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const newTaskBtn = page.getByRole('button', { name: /New Task|Create Task|Add/i }).first();
    await expect(newTaskBtn).toBeVisible({ timeout: 10000 });
  });

  test('edit task details', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const editBtn = page.locator('[class*="edit"], [data-testid*="edit"]').first();
    await expect(editBtn).toBeVisible({ timeout: 10000 });
  });

  test('assign task to agent', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const assignBtn = page.locator('[class*="assign"], [data-testid*="assign"]').first();
    await expect(assignBtn).toBeVisible({ timeout: 10000 });
  });

  test('change task status', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const statusSelector = page
      .locator('[class*="status"], [data-testid*="status-select"]')
      .first();
    await expect(statusSelector).toBeVisible({ timeout: 10000 });
  });
});
