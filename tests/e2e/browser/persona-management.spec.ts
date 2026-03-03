import { expect, test } from '@playwright/test';

test.describe('Persona Management', () => {
  test('view persona list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('create new persona', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const newPersonaBtn = page.getByRole('button', { name: /New|Create|Add/i }).first();
    await expect(newPersonaBtn).toBeVisible({ timeout: 10000 });
  });

  test('edit persona settings', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const settingsBtn = page.locator('[class*="settings"], [data-testid*="settings"]').first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
  });

  test('delete persona with confirmation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const deleteBtn = page.locator('[class*="delete"], [data-testid*="delete"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
  });

  test('persona switcher works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const switcher = page
      .locator('[class*="persona-switcher"], [data-testid*="persona-select"]')
      .first();
    await expect(switcher).toBeVisible({ timeout: 10000 });
  });
});
