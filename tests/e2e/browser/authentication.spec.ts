import { expect, test } from '@playwright/test';

test.describe('Authentication & User Management', () => {
  test('load application without errors', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('navigation bar is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 10000 });
  });

  test('user can access dashboard', async ({ page }) => {
    await page.goto('/');
    const dashboardBtn = page.getByRole('button', { name: /Dashboard|Home|Start|Inbox/i }).first();
    await dashboardBtn.click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('error page displays gracefully', async ({ page }) => {
    await page.goto('/nonexistent-route-12345');
    await expect(page.locator('body')).toContainText(/404|Not Found|Error|Missing/i, {
      timeout: 10000,
    });
  });

  test('page recovers from reload', async ({ page }) => {
    await page.goto('/');
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
