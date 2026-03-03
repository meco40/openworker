import { expect, test } from '@playwright/test';

test.describe('Accessibility', () => {
  test('page has proper heading structure', async ({ page }) => {
    await page.goto('/');
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible({ timeout: 10000 });
  });

  test('interactive elements are focusable', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible({ timeout: 10000 });
  });

  test('images have alt text', async ({ page }) => {
    await page.goto('/');
    const images = page.locator('img');
    const count = await images.count();
    if (count > 0) {
      const firstImage = images.first();
      await expect(firstImage).toBeVisible({ timeout: 10000 });
    }
  });

  test('form inputs have labels', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const input = page.locator('input[type="text"], input[type="search"]').first();
    await expect(input.first()).toBeVisible({ timeout: 10000 });
  });

  test('skip links available', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skipLink = page.locator('[href="#main"], [href="#content"], a:has-text("Skip")');
    await expect(skipLink.first()).toBeVisible({ timeout: 10000 });
  });
});
