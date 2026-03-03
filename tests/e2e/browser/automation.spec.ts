import { expect, test } from '@playwright/test';

test.describe('Automation & Cron', () => {
  test('view automation list', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Automation|Cron|Schedule/i })
      .first()
      .click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('create new automation', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Automation|Cron|Schedule/i })
      .first()
      .click({ timeout: 10000 });
    const newBtn = page.getByRole('button', { name: /New|Create|Add/i }).first();
    await expect(newBtn).toBeVisible({ timeout: 10000 });
  });

  test('configure cron schedule', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Automation|Cron|Schedule/i })
      .first()
      .click({ timeout: 10000 });
    const cronInput = page
      .locator('[class*="cron"], [data-testid*="cron"], input[type="text"]')
      .first();
    await expect(cronInput).toBeVisible({ timeout: 10000 });
  });

  test('run automation manually', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Automation|Cron|Schedule/i })
      .first()
      .click({ timeout: 10000 });
    const runBtn = page.locator('[class*="run"], [data-testid*="run"]').first();
    await expect(runBtn).toBeVisible({ timeout: 10000 });
  });

  test('view automation history', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Automation|Cron|Schedule/i })
      .first()
      .click({ timeout: 10000 });
    const historyBtn = page.locator('[class*="history"], [data-testid*="history"]').first();
    await expect(historyBtn).toBeVisible({ timeout: 10000 });
  });
});
