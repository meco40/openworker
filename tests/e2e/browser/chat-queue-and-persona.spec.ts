import { expect, test } from '@playwright/test';

test('queue and persona controls remain operable while generating', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
  await page.getByTestId('chat-new-conversation').click();

  await page.getByTestId('chat-input').fill('E2E_ABORT_WAIT');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTitle('Generation abbrechen')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('chat-input').fill('second queued');
  await page.getByTestId('chat-send-button').click();

  await expect
    .poll(async () => page.getByTestId('chat-queue-item').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.getByTestId('persona-dropdown-toggle').click();
  await expect(page.getByTestId('persona-dropdown-menu')).toBeVisible();
});
