import { expect, test } from '@playwright/test';

test.describe('Channel Basics', () => {
  test('view channel list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const channelList = page
      .locator('[class*="channel-list"], [data-testid*="channel-list"]')
      .first();
    await expect(channelList).toBeVisible({ timeout: 10000 });
  });

  test('view channel status', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const statusIndicator = page
      .locator('[class*="channel-status"], [data-testid*="status"]')
      .first();
    await expect(statusIndicator).toBeVisible({ timeout: 10000 });
  });

  test('connect new channel', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const connectBtn = page.locator('[class*="connect-channel"], [data-testid*="connect"]').first();
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
  });

  test('disconnect channel', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const disconnectBtn = page
      .locator('[class*="disconnect-channel"], [data-testid*="disconnect"]')
      .first();
    await expect(disconnectBtn).toBeVisible({ timeout: 10000 });
  });

  test('configure channel settings', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const settingsBtn = page
      .locator('[class*="channel-settings"], [data-testid*="settings"]')
      .first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
  });
});
