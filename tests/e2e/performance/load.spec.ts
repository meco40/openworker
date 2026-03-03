import { expect, test } from '@playwright/test';

test.describe('Performance - Load', () => {
  test('page loads within time limit', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(10000);
  });

  test('dashboard loads quickly', async ({ page }) => {
    await page.goto('/');
    const startTime = Date.now();
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(15000);
  });

  test('conversation list loads', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    const startTime = Date.now();
    const list = page.locator('[class*="conversation-list"]').first();
    await list.waitFor({ timeout: 10000 });
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(10000);
  });

  test('message stream starts quickly', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Multi-Channel Inbox|Dashboard/i })
      .first()
      .click({ timeout: 10000 });
    await page.getByTestId('chat-new-conversation').click({ timeout: 5000 });
    await page.getByTestId('chat-input').fill('Test');
    const startTime = Date.now();
    await page.getByTestId('chat-send-button').click();
    const responseTime = Date.now() - startTime;
    expect(responseTime).toBeLessThan(30000);
  });

  test('memory search responds quickly', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Memory|Knowledge/i })
      .first()
      .click({ timeout: 10000 });
    const startTime = Date.now();
    const searchInput = page.locator('[class*="search"]').first();
    await searchInput.waitFor({ timeout: 10000 });
    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(10000);
  });
});
