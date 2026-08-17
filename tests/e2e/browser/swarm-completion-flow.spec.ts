import { expect, test, type Page } from '@playwright/test';

async function openAgentRoom(page: Page) {
  await page.goto('/');
  await page.locator('button[data-view="agent-room"]').click({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'AGENT TEAM' })).toBeVisible({ timeout: 10000 });
}

test.describe('Swarm Completion Flow', () => {
  test('opens the swarm workflow', async ({ page }) => {
    await openAgentRoom(page);
    await expect(page.getByRole('button', { name: /New Task/i })).toBeVisible();
  });

  test('swarm phase setup is visible in UI', async ({ page }) => {
    await openAgentRoom(page);
    await page.getByRole('button', { name: /New Task/i }).click();
    await expect(page.getByRole('dialog', { name: /New Swarm/i })).toBeVisible();
    await expect(page.getByText('Pause Between Phases')).toBeVisible();
  });

  test('swarm artifact workflow is represented in the room', async ({ page }) => {
    await openAgentRoom(page);
    await page.getByRole('button', { name: /New Task/i }).click();
    await expect(page.getByText('Swarm Units')).toBeVisible();
  });
});
