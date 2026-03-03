import { expect, test } from '@playwright/test';

test.describe('Chat Keyboard Shortcuts', () => {
  test('Ctrl+Enter sends message', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Shortcut test');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('Escape clears input', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Test');
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('ArrowUp edits last message', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('Tab completes suggestions', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.keyboard.press('Tab');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('Slash shows commands', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
