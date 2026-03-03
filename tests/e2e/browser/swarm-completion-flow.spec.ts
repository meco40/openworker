import { expect, test } from '@playwright/test';

test.describe('Swarm Completion Flow', () => {
  test('complete swarm through all phases', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Starte einen Swarm zur Code-Analyse');
    await page.getByTestId('chat-send-button').click();

    const lastAgent = page.getByTestId('chat-message-agent').last();
    await expect(lastAgent).toBeVisible({ timeout: 30000 });

    await expect(lastAgent).toContainText(/Swarm|Phase|Agent/, { timeout: 5000 });
  });

  test('swarm phase transitions visible in UI', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Erstelle einen Swarm mit 3 Agenten');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    const swarmIndicator = page.locator('[data-testid*="swarm"], [class*="swarm"]');
    await expect(swarmIndicator.first()).toBeVisible({ timeout: 60000 });
  });

  test('swarm artifact updates during execution', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Multi-Channel Inbox' }).click();
    await page.getByTestId('chat-new-conversation').click();

    await page.getByTestId('chat-input').fill('Swarm: Analysiere die Codebasis');
    await page.getByTestId('chat-send-button').click();

    await expect(page.getByTestId('chat-message-agent').last()).toBeVisible({ timeout: 30000 });

    const artifactContent = page.locator('[class*="artifact"], [data-testid*="artifact"]');
    await expect(artifactContent.first()).toBeVisible({ timeout: 60000 });
  });
});
