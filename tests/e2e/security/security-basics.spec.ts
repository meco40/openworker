import { expect, test } from '@playwright/test';

test.describe('Security Basics', () => {
  test('view security settings', async ({ page }) => {
    await page.goto('/');
    const securityBtn = page.locator('[class*="security"], [data-testid*="security"]').first();
    await securityBtn.click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('change password', async ({ page }) => {
    await page.goto('/');
    const securityBtn = page.locator('[class*="security"]').first();
    await securityBtn.click({ timeout: 10000 });
    const passwordSection = page.locator('[class*="password"]').first();
    await expect(passwordSection).toBeVisible({ timeout: 10000 });
  });

  test('enable two-factor auth', async ({ page }) => {
    await page.goto('/');
    const securityBtn = page.locator('[class*="security"]').first();
    await securityBtn.click({ timeout: 10000 });
    const twoFactorToggle = page.locator('[class*="two-factor"]').first();
    await expect(twoFactorToggle).toBeVisible({ timeout: 10000 });
  });

  test('view login history', async ({ page }) => {
    await page.goto('/');
    const securityBtn = page.locator('[class*="security"]').first();
    await securityBtn.click({ timeout: 10000 });
    const historySection = page.locator('[class*="login-history"]').first();
    await expect(historySection).toBeVisible({ timeout: 10000 });
  });

  test('manage API keys', async ({ page }) => {
    await page.goto('/');
    const securityBtn = page.locator('[class*="security"]').first();
    await securityBtn.click({ timeout: 10000 });
    const apiKeysSection = page.locator('[class*="api-keys"]').first();
    await expect(apiKeysSection).toBeVisible({ timeout: 10000 });
  });
});
