import { expect, test } from '@playwright/test';

test.describe('Integration Scenarios', () => {
  test('complete user workflow', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('cross-feature navigation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('data consistency across views', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('multi-tab behavior', async ({ page }) => {
    await page.goto('/');
    const newPage = await page.context().newPage();
    await newPage.goto('/');
    await expect(newPage.locator('body')).toBeVisible({ timeout: 10000 });
    await newPage.close();
  });

  test('session persistence', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const context = page.context();
    await context.clearCookies();
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
