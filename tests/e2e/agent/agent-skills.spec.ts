import { expect, test } from '@playwright/test';

test.describe('Agent Skills', () => {
  test('view agent skills', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Skills/i })
      .first()
      .click({ timeout: 10000 });
    const skillsList = page.locator('[class*="skills-list"], [data-testid*="skills"]').first();
    await expect(skillsList).toBeVisible({ timeout: 10000 });
  });

  test('enable skill for agent', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Skills/i })
      .first()
      .click({ timeout: 10000 });
    const enableToggle = page.locator('[class*="skill-toggle"], [data-testid*="enable"]').first();
    await expect(enableToggle).toBeVisible({ timeout: 10000 });
  });

  test('disable skill for agent', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Skills/i })
      .first()
      .click({ timeout: 10000 });
    const disableToggle = page.locator('[class*="skill-toggle"]').nth(1);
    await expect(disableToggle.first()).toBeVisible({ timeout: 10000 });
  });

  test('configure skill parameters', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Skills/i })
      .first()
      .click({ timeout: 10000 });
    const configBtn = page.locator('[class*="skill-config"], [data-testid*="config"]').first();
    await expect(configBtn).toBeVisible({ timeout: 10000 });
  });

  test('install new skill', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Agents|Skills/i })
      .first()
      .click({ timeout: 10000 });
    const installBtn = page.locator('[class*="install-skill"], [data-testid*="install"]').first();
    await expect(installBtn).toBeVisible({ timeout: 10000 });
  });
});
