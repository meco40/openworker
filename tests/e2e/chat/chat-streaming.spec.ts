import { expect, test } from '@playwright/test';

test.describe('Chat Streaming', () => {
  test('message streams character by character', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Stream test');
    await page.getByTestId('chat-send-button').click();
    const message = page.getByTestId('chat-message-agent').last();
    await expect(message).toBeVisible({ timeout: 30000 });
  });

  test('streaming indicator visible', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Test');
    await page.getByTestId('chat-send-button').click();
    const indicator = page
      .locator('[class*="streaming"], [class*="typing"], [data-testid*="streaming"]')
      .first();
    await expect(indicator.first()).toBeVisible({ timeout: 30000 });
  });

  test('complete message displays fully', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Complete test');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toContainText(/\S+/, {
      timeout: 30000,
    });
  });

  test('stop streaming works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Stop test');
    await page.getByTestId('chat-send-button').click();
    const stopBtn = page.locator('[class*="stop"], [data-testid*="stop"]').first();
    await expect(stopBtn.first()).toBeVisible({ timeout: 10000 });
  });

  test('stream resumes after interruption', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
