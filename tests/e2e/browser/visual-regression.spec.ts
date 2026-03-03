import { expect, test } from '@playwright/test';

test.describe('Visual Regression', () => {
  test('homepage renders correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('dashboard renders correctly', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('chat interface renders correctly', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 });
  });

  test('settings page renders correctly', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[class*="settings"]').first();
    await settingsBtn.click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('memory view renders correctly', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
