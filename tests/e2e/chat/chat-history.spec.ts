import { expect, test } from '@playwright/test';

test.describe('Chat History', () => {
  test('view conversation history', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const historyList = page.locator('[class*="history"], [data-testid*="history-list"]').first();
    await expect(historyList).toBeVisible({ timeout: 10000 });
  });

  test('load previous conversation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const conversationItem = page
      .locator('[class*="conversation-item"], [data-testid*="conversation"]')
      .first();
    await expect(conversationItem).toBeVisible({ timeout: 10000 });
  });

  test('rename conversation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const renameBtn = page.locator('[class*="rename"], [data-testid*="rename"]').first();
    await expect(renameBtn).toBeVisible({ timeout: 10000 });
  });

  test('archive conversation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const archiveBtn = page.locator('[class*="archive"], [data-testid*="archive"]').first();
    await expect(archiveBtn).toBeVisible({ timeout: 10000 });
  });

  test('pin conversation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const pinBtn = page.locator('[class*="pin"], [data-testid*="pin"]').first();
    await expect(pinBtn).toBeVisible({ timeout: 10000 });
  });
});
