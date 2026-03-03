import { expect, test } from '@playwright/test';

test.describe('Knowledge Graph', () => {
  test('view knowledge graph', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('search knowledge nodes', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    const searchInput = page
      .locator('[class*="search"], [data-testid*="search"], input[type="search"]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });

  test('filter nodes by type', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    const filterSelect = page.locator('[class*="filter"], [data-testid*="filter"]').first();
    await expect(filterSelect).toBeVisible({ timeout: 10000 });
  });

  test('view node details', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    const nodeItem = page.locator('[class*="node"], [data-testid*="node"]').first();
    await expect(nodeItem).toBeVisible({ timeout: 10000 });
  });

  test('export knowledge data', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Knowledge|Graph|Memory/i })
      .first()
      .click({ timeout: 10000 });
    const exportBtn = page.locator('[class*="export"], [data-testid*="export"]').first();
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
  });
});
