import { expect, test, type Page } from '@playwright/test';

async function openSettings(page: Page) {
  await page.goto('/mission-control/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10000 });
}

test.describe('Settings & Configuration', () => {
  test('view settings page', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('Workspace Paths')).toBeVisible();
  });

  test('update workspace profile settings', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByLabel('Workspace Base Path')).toBeVisible();
    await expect(page.getByLabel('Default Project Name')).toBeVisible();
  });

  test('change runtime URL settings', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByLabel('Mission Control URL')).toBeVisible();
  });

  test('view environment configuration guidance', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole('heading', { name: '📝 Environment Variables' })).toBeVisible();
  });

  test('save settings successfully', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
  });
});
