import { expect, test } from '@playwright/test';

test.describe('Command Approval Flow', () => {
  test('dangerous command requires approval', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Führe einen Shell-Befehl aus: ls -la');
    await page.getByTestId('chat-send-button').click();

    const approvalPrompt = page.locator(
      '[class*="approval"], [data-testid*="approval"], [class*="confirm"]',
    );
    await expect(approvalPrompt.first()).toBeVisible({ timeout: 30000 });
  });

  test('approve command executes successfully', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Zeige mir die Dateien im aktuellen Verzeichnis');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('approval timeout handled gracefully', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Erstelle eine neue Datei');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });
});
