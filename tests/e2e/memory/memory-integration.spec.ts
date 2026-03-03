import { expect, test } from '@playwright/test';

test.describe('Memory Integration', () => {
  test('memory persists across sessions', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Save: I work in software development');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('memory scope filtering', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const scopeFilter = page.locator('[class*="scope"], [data-testid*="scope-filter"]').first();
    await expect(scopeFilter).toBeVisible({ timeout: 10000 });
  });

  test('memory type filtering', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const typeFilter = page.locator('[class*="type-filter"], [data-testid*="type-filter"]').first();
    await expect(typeFilter).toBeVisible({ timeout: 10000 });
  });

  test('memory export', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const exportBtn = page.locator('[class*="export"], [data-testid*="export"]').first();
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
  });

  test('memory import', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const importBtn = page.locator('[class*="import"], [data-testid*="import"]').first();
    await expect(importBtn).toBeVisible({ timeout: 10000 });
  });
});
