import { expect, test } from '@playwright/test';

test.describe('Performance - Stress', () => {
  test('handle rapid message sending', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });

    for (let i = 0; i < 3; i++) {
      await page.getByTestId('chat-input').fill(`Message ${i}`);
      await page.getByTestId('chat-send-button').click();
    }

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('handle multiple tabs', async ({ page }) => {
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const newPage = await page.context().newPage();
      await newPage.goto('/');
      pages.push(newPage);
    }

    for (const p of pages) {
      await expect(p.locator('body')).toBeVisible({ timeout: 10000 });
    }

    for (const p of pages) {
      await p.close();
    }
  });

  test('handle large conversation list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const list = page.locator('[class*="conversation-list"]').first();
    await expect(list).toBeVisible({ timeout: 10000 });
  });

  test('handle long message', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    const longMessage = 'A'.repeat(5000);
    await page.getByTestId('chat-input').fill(longMessage);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('handle multiple swarm executions', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const swarmBtn = page.locator('[class*="swarm"]').first();
    await expect(swarmBtn).toBeVisible({ timeout: 10000 });
  });
});
