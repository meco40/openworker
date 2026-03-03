import { expect, test } from '@playwright/test';

test.describe('Memory Operations', () => {
  test('create memory entry', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Remember this: TypeScript is my favorite language');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('recall memory', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('What do you remember about me?');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('delete memory entry', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const deleteBtn = page
      .locator('[class*="delete-memory"], [data-testid*="delete-memory"]')
      .first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
  });

  test('memory search works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const searchInput = page.locator('[class*="search"], [data-testid*="search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });

  test('memory list pagination', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const pagination = page.locator('[class*="pagination"], [data-testid*="pagination"]').first();
    await expect(pagination).toBeVisible({ timeout: 10000 });
  });
});
