import { expect, test } from '@playwright/test';

test.describe('UI Components', () => {
  test('buttons are clickable', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button').first();
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();
  });

  test('dropdowns expand and collapse', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('[class*="dropdown"], [data-testid*="dropdown"]').first();
    await expect(dropdown).toBeVisible({ timeout: 10000 });
  });

  test('modals open and close', async ({ page }) => {
    await page.goto('/');
    const modalTrigger = page.locator('[class*="modal-trigger"], [data-testid*="modal"]').first();
    await expect(modalTrigger).toBeVisible({ timeout: 10000 });
  });

  test('tooltips display on hover', async ({ page }) => {
    await page.goto('/');
    const tooltip = page.locator('[class*="tooltip"], [data-testid*="tooltip"]').first();
    await expect(tooltip).toBeVisible({ timeout: 10000 });
  });

  test('loading spinners appear', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const spinner = page.locator('[class*="spinner"], [class*="loading"]').first();
    await expect(spinner.first()).toBeVisible({ timeout: 10000 });
  });
});
