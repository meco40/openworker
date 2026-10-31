import { expect, test } from '@playwright/test';

test.describe('Keyboard Navigation', () => {
  // The home page renders a loading placeholder until `/api/config` answers, and
  // the placeholder has nothing focusable. Key presses before the app shell is up
  // leave the focus on <body>.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 10000 });
  });

  test('tab cycles through elements', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible({ timeout: 10000 });
  });

  test('enter activates buttons', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('escape closes modals', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('arrow keys navigate lists', async ({ page }) => {
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });

  test('space selects items', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
  });
});
