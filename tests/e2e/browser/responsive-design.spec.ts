import { expect, test } from '@playwright/test';

test.describe('Responsive Design', () => {
  test('mobile viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('tablet viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('desktop viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('mobile navigation uses a labelled drawer without reserving content width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.getByTestId('app-sidebar')).toBeHidden();
    const trigger = page.getByTestId('mobile-navigation-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mobile-navigation-drawer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Multi-Channel Inbox' })).toBeVisible();

    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(page.getByTestId('mobile-navigation-drawer')).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
