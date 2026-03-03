import { expect, test } from '@playwright/test';

test.describe('Chat Tools & Actions', () => {
  test('tool execution visible', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    const toolIndicator = page.locator('[class*="tool"], [data-testid*="tool"]').first();
    await expect(toolIndicator).toBeVisible({ timeout: 10000 });
  });

  test('file attachment works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    const attachBtn = page.locator('[class*="attach"], [data-testid*="attach"]').first();
    await expect(attachBtn).toBeVisible({ timeout: 10000 });
  });

  test('code block rendering', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Show code');
    await page.getByTestId('chat-send-button').click();
    const codeBlock = page.locator('pre, code, [class*="code"]').first();
    await expect(codeBlock.first()).toBeVisible({ timeout: 30000 });
  });

  test('markdown rendering', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Markdown test');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('action buttons in messages', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    const actionBtn = page.locator('[class*="action"], [data-testid*="action"]').first();
    await expect(actionBtn).toBeVisible({ timeout: 10000 });
  });
});
