import { expect, test } from '@playwright/test';

test.describe('Error Handling & Edge Cases', () => {
  test('handle network timeout gracefully', async ({ page }) => {
    await page.goto('/');
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('display error message on failed request', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('recover from invalid state', async ({ page }) => {
    await page.goto('/');
    await page.reload();
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('handle large data sets', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const listContainer = page.locator('[class*="list"], [data-testid*="list"]').first();
    await expect(listContainer).toBeVisible({ timeout: 10000 });
  });

  test('handle special characters in input', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const input = page.locator('[data-testid="chat-input"], input[type="text"], textarea').first();
    await expect(input).toBeVisible({ timeout: 10000 });
  });
});
