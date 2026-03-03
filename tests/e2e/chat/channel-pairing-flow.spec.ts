import { expect, test } from '@playwright/test';

test.describe('Channel Pairing Flow', () => {
  test('initiate channel pairing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();

    const channelButton = page.locator(
      'button:has-text("Telegram"), button:has-text("Channel"), [data-testid*="channel"]',
    );
    await expect(channelButton.first()).toBeVisible({ timeout: 10000 });
  });

  test('pairing code displayed', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();

    const pairingSection = page.locator(
      '[class*="pairing"], [data-testid*="pairing"], [class*="verification"]',
    );
    await expect(pairingSection.first()).toBeVisible({ timeout: 10000 });
  });

  test('paired channel shows in UI', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();

    const channelList = page.locator('[class*="channel-list"], [data-testid*="channel-list"]');
    await expect(channelList.first()).toBeVisible({ timeout: 10000 });
  });

  test('conversation persists after page reload', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Test Nachricht');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    await page.reload();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 10000 });
  });
});
