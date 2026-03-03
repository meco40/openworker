import { expect, test } from '@playwright/test';

test.describe('Ops Dashboard', () => {
  test('view ops dashboard', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Ops|Dashboard|Monitoring/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('view agent status', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Ops|Dashboard|Monitoring/i })
      .first()
      .click({ timeout: 10000 });
    const agentStatus = page
      .locator('[class*="agent-status"], [data-testid*="agent-status"]')
      .first();
    await expect(agentStatus).toBeVisible({ timeout: 10000 });
  });

  test('view session metrics', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Ops|Dashboard|Monitoring/i })
      .first()
      .click({ timeout: 10000 });
    const metrics = page.locator('[class*="metrics"], [data-testid*="metrics"]').first();
    await expect(metrics).toBeVisible({ timeout: 10000 });
  });

  test('filter by date range', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Ops|Dashboard|Monitoring/i })
      .first()
      .click({ timeout: 10000 });
    const dateFilter = page.locator('[class*="date"], [data-testid*="date-filter"]').first();
    await expect(dateFilter).toBeVisible({ timeout: 10000 });
  });

  test('export ops data', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Ops|Dashboard|Monitoring/i })
      .first()
      .click({ timeout: 10000 });
    const exportBtn = page.locator('[class*="export"], [data-testid*="export"]').first();
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
  });
});
