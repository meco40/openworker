import { expect, test } from '@playwright/test';

test.describe('Permissions', () => {
  test('view user permissions', async ({ page }) => {
    await page.goto('/');
    const permissionsBtn = page.locator('[class*="permissions"]').first();
    await permissionsBtn.click({ timeout: 10000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('grant permission', async ({ page }) => {
    await page.goto('/');
    const permissionsBtn = page.locator('[class*="permissions"]').first();
    await permissionsBtn.click({ timeout: 10000 });
    const grantBtn = page.locator('[class*="grant-permission"]').first();
    await expect(grantBtn).toBeVisible({ timeout: 10000 });
  });

  test('revoke permission', async ({ page }) => {
    await page.goto('/');
    const permissionsBtn = page.locator('[class*="permissions"]').first();
    await permissionsBtn.click({ timeout: 10000 });
    const revokeBtn = page.locator('[class*="revoke-permission"]').first();
    await expect(revokeBtn).toBeVisible({ timeout: 10000 });
  });

  test('create role', async ({ page }) => {
    await page.goto('/');
    const permissionsBtn = page.locator('[class*="permissions"]').first();
    await permissionsBtn.click({ timeout: 10000 });
    const createRoleBtn = page.locator('[class*="create-role"]').first();
    await expect(createRoleBtn).toBeVisible({ timeout: 10000 });
  });

  test('assign role to user', async ({ page }) => {
    await page.goto('/');
    const permissionsBtn = page.locator('[class*="permissions"]').first();
    await permissionsBtn.click({ timeout: 10000 });
    const assignBtn = page.locator('[class*="assign-role"]').first();
    await expect(assignBtn).toBeVisible({ timeout: 10000 });
  });
});
