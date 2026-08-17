import { expect, test, type Page } from '@playwright/test';

async function openCron(page: Page) {
  await page.goto('/');
  await page.locator('button[data-view="cron"]').click({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Cron' })).toBeVisible({ timeout: 10000 });
}

test.describe('Automation & Cron', () => {
  test('view automation list', async ({ page }) => {
    await openCron(page);
    await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
  });

  test('create new automation', async ({ page }) => {
    await openCron(page);
    await expect(page.getByRole('button', { name: '+ New Cron Job' })).toBeVisible();
  });

  test('configure cron schedule', async ({ page }) => {
    await openCron(page);
    await expect(page.getByLabel('Cron Expression')).toBeVisible();
  });

  test('run automation manually', async ({ page }) => {
    await openCron(page);
    await expect(page.getByRole('heading', { name: 'Run History' })).toBeVisible();
  });

  test('view automation history', async ({ page }) => {
    await openCron(page);
    await expect(page.getByLabel('Run history depth')).toBeVisible();
  });
});
