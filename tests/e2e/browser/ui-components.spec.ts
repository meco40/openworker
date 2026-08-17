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
    await page.locator('button[data-view="chat"]').click({ timeout: 10000 });
    await page.getByTestId('persona-dropdown-toggle').click({ timeout: 10000 });
    await expect(page.getByTestId('persona-dropdown-menu')).toBeVisible();
    await page.getByTestId('persona-dropdown-toggle').click();
    await expect(page.getByTestId('persona-dropdown-menu')).toBeHidden();
  });

  test('modals open and close', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="tasks"]').click({ timeout: 10000 });
    await page.getByRole('button', { name: 'New Task' }).click();
    await expect(page.getByRole('dialog', { name: 'New Task' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'New Task' })).toBeHidden();
  });

  test('tooltips provide titles for icon controls', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="personas"]').click({ timeout: 10000 });
    const createButton = page.getByTitle('Neue Persona');
    await expect(createButton).toBeVisible({ timeout: 10000 });
    await expect(createButton).toHaveAttribute('title', 'Neue Persona');
  });

  test('loading states expose an accessible status', async ({ page }) => {
    await page.route('**/api/tasks**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue();
    });
    await page.goto('/');
    await page.locator('button[data-view="tasks"]').click({ timeout: 10000 });
    await expect(page.getByRole('status').first()).toBeVisible({ timeout: 10000 });
  });
});
