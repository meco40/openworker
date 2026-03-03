import { expect, test } from '@playwright/test';

test.describe('WhatsApp Channel', () => {
  test('configure WhatsApp Business', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|WhatsApp/i })
      .first()
      .click({ timeout: 10000 });
    const configSection = page.locator('[class*="whatsapp-config"]').first();
    await expect(configSection).toBeVisible({ timeout: 10000 });
  });

  test('connect WhatsApp number', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|WhatsApp/i })
      .first()
      .click({ timeout: 10000 });
    const numberInput = page.locator('[class*="phone-number"]').first();
    await expect(numberInput).toBeVisible({ timeout: 10000 });
  });

  test('verify WhatsApp connection', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|WhatsApp/i })
      .first()
      .click({ timeout: 10000 });
    const verifyBtn = page.locator('[class*="verify-whatsapp"]').first();
    await expect(verifyBtn).toBeVisible({ timeout: 10000 });
  });

  test('view WhatsApp messages', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|WhatsApp/i })
      .first()
      .click({ timeout: 10000 });
    const messagesList = page.locator('[class*="whatsapp-messages"]').first();
    await expect(messagesList).toBeVisible({ timeout: 10000 });
  });

  test('configure WhatsApp templates', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Channels|WhatsApp/i })
      .first()
      .click({ timeout: 10000 });
    const templatesSection = page.locator('[class*="template-config"]').first();
    await expect(templatesSection).toBeVisible({ timeout: 10000 });
  });
});
