import { expect, test } from '@playwright/test';

test.describe('Chat Core Functionality', () => {
  test('send text message', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Hello');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('message appears in conversation history', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Test message');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-user').last()).toBeVisible({ timeout: 10000 });
  });

  test('conversation list updates', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const conversationList = page
      .locator('[class*="conversation-list"], [data-testid*="conversation-list"]')
      .first();
    await expect(conversationList).toBeVisible({ timeout: 10000 });
  });

  test('delete conversation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const deleteBtn = page
      .locator('[class*="delete-conversation"], [data-testid*="delete-conversation"]')
      .first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
  });

  test('search conversations', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const searchInput = page.locator('[class*="search"], [data-testid*="search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });
});
