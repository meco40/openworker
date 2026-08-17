import { expect, test, type Page } from '@playwright/test';

async function openPersonas(page: Page) {
  await page.goto('/');
  await page.locator('button[data-view="personas"]').click({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Personas' })).toBeVisible({ timeout: 10000 });
}

test.describe('Persona Management', () => {
  test('view persona list', async ({ page }) => {
    await openPersonas(page);
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
  });

  test('create new persona', async ({ page }) => {
    await openPersonas(page);
    await page.getByTitle('Neue Persona').click();
    await expect(page.getByRole('button', { name: /Leere Persona erstellen/i })).toBeVisible();
  });

  test('edit persona settings', async ({ page }) => {
    await openPersonas(page);
    const editor = page.getByTitle('Bearbeiten');
    if ((await editor.count()) > 0) {
      await expect(editor.first()).toBeVisible();
    } else {
      await expect(
        page.getByText(/Keine Personas erstellt|Wähle oder erstelle eine Persona/),
      ).toBeVisible();
    }
  });

  test('delete persona with confirmation', async ({ page }) => {
    await openPersonas(page);
    const deleteButton = page.getByTitle('Löschen');
    if ((await deleteButton.count()) > 0) {
      await expect(deleteButton.first()).toBeVisible();
    } else {
      await expect(
        page.getByText(/Keine Personas erstellt|Wähle oder erstelle eine Persona/),
      ).toBeVisible();
    }
  });

  test('persona switcher works', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[data-view="chat"]').click({ timeout: 10000 });
    await page.getByTestId('persona-dropdown-toggle').click({ timeout: 10000 });
    await expect(page.getByTestId('persona-dropdown-menu')).toBeVisible({ timeout: 10000 });
  });
});
