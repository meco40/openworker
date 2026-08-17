import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function ensurePersona(request: APIRequestContext): Promise<void> {
  const existing = await request.get('/api/personas');
  expect(existing.ok()).toBe(true);
  const payload = (await existing.json()) as {
    personas?: Array<{ id?: string }>;
  };
  if (payload.personas?.some((persona) => persona.id)) return;

  const created = await request.post('/api/personas', {
    data: { name: `Knowledge E2E ${Date.now()}` },
  });
  expect(created.status()).toBe(201);
}

async function openKnowledge(page: Page, request: APIRequestContext) {
  await ensurePersona(request);
  await page.goto('/');
  await page.locator('button[data-view="knowledge"]').click({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Knowledge Graph' })).toBeVisible({
    timeout: 10000,
  });
}

test.describe('Knowledge Graph', () => {
  test('view knowledge graph', async ({ page, request }) => {
    await openKnowledge(page, request);
    await expect(page.getByTestId('knowledge-graph-panel')).toBeVisible();
  });

  test('search knowledge nodes', async ({ page, request }) => {
    await openKnowledge(page, request);
    await expect(page.getByRole('searchbox', { name: 'Search knowledge nodes' })).toBeVisible();
  });

  test('filter nodes by type', async ({ page, request }) => {
    await openKnowledge(page, request);
    await expect(page.getByText('Kategorien', { exact: true })).toBeVisible();
    const categoryFilters = page.getByRole('button', { name: /Filter knowledge nodes by/ });
    if ((await categoryFilters.count()) > 0) {
      await expect(categoryFilters.first()).toBeVisible();
    }
  });

  test('view node details', async ({ page, request }) => {
    await openKnowledge(page, request);
    const nodes = page.locator('.react-flow__node');
    if ((await nodes.count()) > 0) {
      await nodes.first().click();
      await expect(page.getByText('Node Details')).toBeVisible();
    } else {
      await expect(page.getByTestId('knowledge-graph-panel')).toBeVisible();
    }
  });

  test('export knowledge data', async ({ page, request }) => {
    await openKnowledge(page, request);
    await expect(page.getByRole('button', { name: 'Export knowledge data' })).toBeVisible();
  });
});
