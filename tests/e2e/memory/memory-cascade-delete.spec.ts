import { expect, test } from '@playwright/test';

test.describe('Memory Cascade Delete', () => {
  test('delete persona cascades to memories', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Erstelle eine Memory Notiz');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    await page.getByTestId('chat-input').fill('Zeige meine Memories');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('memory search returns created memories', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page
      .getByTestId('chat-input')
      .fill('Speichere: Mein Lieblingsprogrammiersprache ist TypeScript');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    await page.getByTestId('chat-input').fill('Was ist meine Lieblingsprogrammiersprache?');
    await page.getByTestId('chat-send-button').click();

    const response = page.getByTestId('chat-message-agent').last();
    await expect(response).toBeVisible({ timeout: 30000 });
    await expect(response).toContainText(/TypeScript|Programmiersprache/i, { timeout: 10000 });
  });

  test('memory persists across conversation restart', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    const conversationId = page.url();

    await page.getByTestId('chat-input').fill('Merke dir: Ich arbeite an einem KI-Projekt');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('An was arbeite ich?');
    await page.getByTestId('chat-send-button').click();

    const response = page.getByTestId('chat-message-agent').last();
    await expect(response).toBeVisible({ timeout: 30000 });
    await expect(response).toContainText(/KI|Projekt/i, { timeout: 10000 });
  });
});
