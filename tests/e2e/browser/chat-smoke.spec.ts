import { expect, test } from '@playwright/test';

test('user can send message and receive stream completion marker', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
  await page.getByTestId('chat-new-conversation').click();
  await page.getByTestId('chat-input').fill('Hallo Nexus');
  await page.getByTestId('chat-send-button').click();
  const lastAgent = page.getByTestId('chat-message-agent').last();
  await expect(lastAgent).toBeVisible();
  await expect(lastAgent).toContainText(/\S+/);
});
