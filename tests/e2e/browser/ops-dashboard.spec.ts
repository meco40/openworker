import { expect, test } from '@playwright/test';

test.describe('Ops Dashboard', () => {
  test('view ops dashboard', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="instances"]').click({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Instances' })).toBeVisible({ timeout: 10000 });
  });

  test('view agent status', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="instances"]').click({ timeout: 10000 });
    await expect(page.getByRole('region', { name: 'Instance metrics' })).toBeVisible({
      timeout: 10000,
    });
  });

  test('view session metrics', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="sessions"]').click({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible({ timeout: 10000 });
  });

  test('filter session data', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="sessions"]').click({ timeout: 10000 });
    await expect(page.getByPlaceholder('Search sessions')).toBeVisible({ timeout: 10000 });
  });

  test('refresh ops data', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="instances"]').click({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Refresh instance telemetry' })).toBeVisible({
      timeout: 10000,
    });
  });
});
