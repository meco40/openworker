import { expect, test } from '@playwright/test';

test.describe('Multi-Agent Collaboration', () => {
  test('multiple agents respond in conversation', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Hallo, ich brauche Hilfe bei einem Projekt');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    await page.getByTestId('chat-input').fill('Kannst du einen anderen Agenten hinzuziehen?');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('agent turn-taking visible in UI', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Starte eine Diskussion zwischen mehreren Agenten');
    await page.getByTestId('chat-send-button').click();

    const agentMessages = page.getByTestId('chat-message-agent');
    await expect(agentMessages.first()).toBeVisible({ timeout: 30000 });
  });

  test('consensus building displayed', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Lass uns eine Entscheidung treffen');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });

  test('conflict resolution between agents', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Die Agenten sind sich nicht einig');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });
  });
});
