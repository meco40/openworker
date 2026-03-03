import { expect, test } from '@playwright/test';

test.describe('Agent Capabilities', () => {
  test('view agent capabilities', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Capabilities/i })
      .first()
      .click({ timeout: 10000 });
    const capabilitiesList = page
      .locator('[class*="capabilities"], [data-testid*="capabilities"]')
      .first();
    await expect(capabilitiesList).toBeVisible({ timeout: 10000 });
  });

  test('enable capability', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Capabilities/i })
      .first()
      .click({ timeout: 10000 });
    const enableBtn = page.locator('[class*="enable-capability"]').first();
    await expect(enableBtn).toBeVisible({ timeout: 10000 });
  });

  test('disable capability', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Capabilities/i })
      .first()
      .click({ timeout: 10000 });
    const disableBtn = page.locator('[class*="disable-capability"]').first();
    await expect(disableBtn).toBeVisible({ timeout: 10000 });
  });

  test('configure capability settings', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Capabilities/i })
      .first()
      .click({ timeout: 10000 });
    const settingsBtn = page.locator('[class*="capability-settings"]').first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
  });

  test('test capability', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Capabilities/i })
      .first()
      .click({ timeout: 10000 });
    const testBtn = page.locator('[class*="test-capability"]').first();
    await expect(testBtn).toBeVisible({ timeout: 10000 });
  });
});
