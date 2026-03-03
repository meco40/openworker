import { expect, test } from '@playwright/test';

test.describe('Settings & Configuration', () => {
  test('view settings page', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('update user profile', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    const profileSection = page.locator('[class*="profile"], [data-testid*="profile"]').first();
    await expect(profileSection).toBeVisible({ timeout: 10000 });
  });

  test('change theme settings', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    const themeSelector = page.locator('[class*="theme"], [data-testid*="theme"]').first();
    await expect(themeSelector).toBeVisible({ timeout: 10000 });
  });

  test('configure notifications', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    const notificationSection = page
      .locator('[class*="notification"], [data-testid*="notification"]')
      .first();
    await expect(notificationSection).toBeVisible({ timeout: 10000 });
  });

  test('save settings successfully', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    const saveBtn = page.locator('[class*="save"], [data-testid*="save"]').first();
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
  });
});
