import { expect, test } from '@playwright/test';

test('queue and persona controls remain operable while generating', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
  await page.getByTestId('chat-new-conversation').click();

  await page.getByTestId('chat-input').fill('E2E_ABORT_WAIT');
  await page.getByTestId('chat-send-button').click();

  await page.getByTestId('chat-input').fill('second queued');
  await page.getByTestId('chat-send-button').click();

  await expect(page.getByTestId('chat-queue-list')).toBeVisible();
  await expect(page.getByTestId('chat-queue-item').first()).toBeVisible();

  await page.getByTestId('persona-dropdown-toggle').click();
  await expect(page.getByTestId('persona-dropdown-menu')).toBeVisible();
});
