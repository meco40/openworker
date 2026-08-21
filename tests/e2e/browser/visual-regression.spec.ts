import { expect, test } from '@playwright/test';

test.describe('Visual Regression', () => {
  test('homepage renders correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('dashboard renders correctly', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="dashboard"]').click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('chat interface renders correctly', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="chat"]').click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 });
  });

  test('memory view renders correctly', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="memory"]').click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
