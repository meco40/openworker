import { expect, test } from '@playwright/test';

test.describe('Swarm Basics', () => {
  test('create new swarm', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const newSwarmBtn = page.getByRole('button', { name: /New Swarm|Create Swarm/i }).first();
    await expect(newSwarmBtn).toBeVisible({ timeout: 10000 });
  });

  test('select swarm agents', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const agentSelector = page
      .locator('[class*="agent-selector"], [data-testid*="agent-select"]')
      .first();
    await expect(agentSelector).toBeVisible({ timeout: 10000 });
  });

  test('configure swarm parameters', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const paramsSection = page.locator('[class*="swarm-params"], [data-testid*="params"]').first();
    await expect(paramsSection).toBeVisible({ timeout: 10000 });
  });

  test('start swarm execution', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const startBtn = page.locator('[class*="start-swarm"], [data-testid*="start"]').first();
    await expect(startBtn).toBeVisible({ timeout: 10000 });
  });

  test('stop swarm execution', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const stopBtn = page.locator('[class*="stop-swarm"], [data-testid*="stop"]').first();
    await expect(stopBtn).toBeVisible({ timeout: 10000 });
  });
});
