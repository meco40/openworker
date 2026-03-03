import { expect, test } from '@playwright/test';

test.describe('Swarm Monitoring', () => {
  test('view swarm progress', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const progressIndicator = page
      .locator('[class*="progress"], [data-testid*="progress"]')
      .first();
    await expect(progressIndicator).toBeVisible({ timeout: 10000 });
  });

  test('view agent contributions', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const contributionsList = page
      .locator('[class*="contribution"], [data-testid*="contribution"]')
      .first();
    await expect(contributionsList).toBeVisible({ timeout: 10000 });
  });

  test('view consensus score', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const consensusDisplay = page
      .locator('[class*="consensus"], [data-testid*="consensus"]')
      .first();
    await expect(consensusDisplay).toBeVisible({ timeout: 10000 });
  });

  test('view friction level', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const frictionDisplay = page.locator('[class*="friction"], [data-testid*="friction"]').first();
    await expect(frictionDisplay).toBeVisible({ timeout: 10000 });
  });

  test('export swarm results', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const exportBtn = page.locator('[class*="export-swarm"], [data-testid*="export"]').first();
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
  });
});
