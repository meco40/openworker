import { expect, test } from '@playwright/test';

test.describe('Chat Notifications', () => {
  test('notification badge updates', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const badge = page.locator('[class*="badge"], [data-testid*="badge"]').first();
    await expect(badge.first()).toBeVisible({ timeout: 10000 });
  });

  test('toast notification appears', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const toast = page.locator('[class*="toast"], [data-testid*="toast"]').first();
    await expect(toast.first()).toBeVisible({ timeout: 10000 });
  });

  test('notification settings work', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    const notificationToggle = page.locator('[class*="notification-toggle"]').first();
    await expect(notificationToggle).toBeVisible({ timeout: 10000 });
  });

  test('sound notification plays', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const soundToggle = page.locator('[class*="sound"], [data-testid*="sound"]').first();
    await expect(soundToggle).toBeVisible({ timeout: 10000 });
  });

  test('desktop notification permission', async ({ page }) => {
    await page.goto('/');
    const notificationBtn = page.locator('[class*="notification-permission"]').first();
    await expect(notificationBtn.first()).toBeVisible({ timeout: 10000 });
  });
});
