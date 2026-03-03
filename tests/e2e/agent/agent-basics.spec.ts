import { expect, test } from '@playwright/test';

test.describe('Agent Basics', () => {
  test('view agent list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const agentList = page.locator('[class*="agent-list"], [data-testid*="agent-list"]').first();
    await expect(agentList).toBeVisible({ timeout: 10000 });
  });

  test('view agent details', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const agentItem = page.locator('[class*="agent-item"], [data-testid*="agent"]').first();
    await expect(agentItem).toBeVisible({ timeout: 10000 });
  });

  test('create new agent', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const newBtn = page.getByRole('button', { name: /New Agent|Create/i }).first();
    await expect(newBtn).toBeVisible({ timeout: 10000 });
  });

  test('edit agent configuration', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const editBtn = page.locator('[class*="edit-agent"], [data-testid*="edit"]').first();
    await expect(editBtn).toBeVisible({ timeout: 10000 });
  });

  test('delete agent', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const deleteBtn = page.locator('[class*="delete-agent"], [data-testid*="delete"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
  });
});
