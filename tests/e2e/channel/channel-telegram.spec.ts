import { expect, test } from '@playwright/test';

test.describe('Telegram Channel', () => {
  test('configure Telegram bot', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Telegram/i })
      .first()
      .click({ timeout: 10000 });
    const configSection = page
      .locator('[class*="telegram-config"], [data-testid*="telegram"]')
      .first();
    await expect(configSection).toBeVisible({ timeout: 10000 });
  });

  test('enter bot token', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Telegram/i })
      .first()
      .click({ timeout: 10000 });
    const tokenInput = page.locator('[class*="bot-token"], [data-testid*="token"]').first();
    await expect(tokenInput).toBeVisible({ timeout: 10000 });
  });

  test('verify bot connection', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Telegram/i })
      .first()
      .click({ timeout: 10000 });
    const verifyBtn = page.locator('[class*="verify-bot"], [data-testid*="verify"]').first();
    await expect(verifyBtn).toBeVisible({ timeout: 10000 });
  });

  test('view Telegram conversations', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Telegram/i })
      .first()
      .click({ timeout: 10000 });
    const conversationsList = page.locator('[class*="telegram-conversations"]').first();
    await expect(conversationsList.first()).toBeVisible({ timeout: 10000 });
  });

  test('configure webhook', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|Telegram/i })
      .first()
      .click({ timeout: 10000 });
    const webhookSection = page.locator('[class*="webhook-config"]').first();
    await expect(webhookSection).toBeVisible({ timeout: 10000 });
  });
});
