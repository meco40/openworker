import { expect, test } from '@playwright/test';

test.describe('Swarm History', () => {
  test('view past swarms', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Swarms/i })
      .first()
      .click({ timeout: 10000 });
    const swarmList = page.locator('[class*="swarm-list"], [data-testid*="swarm-list"]').first();
    await expect(swarmList).toBeVisible({ timeout: 10000 });
  });

  test('filter swarms by status', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Swarms/i })
      .first()
      .click({ timeout: 10000 });
    const statusFilter = page
      .locator('[class*="status-filter"], [data-testid*="status-filter"]')
      .first();
    await expect(statusFilter).toBeVisible({ timeout: 10000 });
  });

  test('filter swarms by date', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Swarms/i })
      .first()
      .click({ timeout: 10000 });
    const dateFilter = page.locator('[class*="date-filter"], [data-testid*="date-filter"]').first();
    await expect(dateFilter).toBeVisible({ timeout: 10000 });
  });

  test('view swarm details', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Swarms/i })
      .first()
      .click({ timeout: 10000 });
    const detailBtn = page.locator('[class*="detail"], [data-testid*="detail"]').first();
    await expect(detailBtn).toBeVisible({ timeout: 10000 });
  });

  test('rerun swarm', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard|Swarms/i })
      .first()
      .click({ timeout: 10000 });
    const rerunBtn = page.locator('[class*="rerun"], [data-testid*="rerun"]').first();
    await expect(rerunBtn).toBeVisible({ timeout: 10000 });
  });
});
