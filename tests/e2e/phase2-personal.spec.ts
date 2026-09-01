import {expect, test} from '@playwright/test';

test.describe('Phase 2 signed personal workspace', () => {
  test.beforeEach(async ({context}) => {
    await context.clearCookies();
  });

  test('reviews, persists, exports, imports, reopens offline, and enforces viewer mode', async ({page, request}) => {
    await page.goto('/?personal=1');
    await expect(page.getByRole('heading', {name: 'Decision Board', level: 2})).toBeVisible();
    await expect(page.getByText('cryptographic key—not verified legal identity')).toBeVisible();
    await expect(page.getByText(/Do not enter passwords/)).toBeVisible();
    await expect(page.frameLocator('iframe').getByRole('button')).toHaveCount(0);

    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();

    await page.getByRole('button', {name: 'Workspace'}).click();
    await expect(page.getByText(/Saved locally:/)).not.toContainText('not yet');
    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Export readable JSON'}).click();
    await expect((await jsonDownload).suggestedFilename()).toBe('decision-board-state.json');

    await page.getByRole('button', {name: 'Import JSON'}).click();
    await page.locator('#import-file').setInputFiles({name: 'state.json', mimeType: 'application/json', buffer: Buffer.from('{"decisions":{"a":{"title":"A"},"b":{"title":"B"}}}')});
    await expect(app.getByText('2 decisions')).toBeVisible();

    await page.locator('#import-file').setInputFiles({name: 'invalid-state.json', mimeType: 'application/json', buffer: Buffer.from('{"decisions":{"bad":{"title":5}}}')});
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_SCHEMA_INVALID');
    await expect(app.getByText('2 decisions')).toBeVisible();

    await page.locator('#import-file').setInputFiles({name: 'extra-state.json', mimeType: 'application/json', buffer: Buffer.from('{"decisions":{},"unexpected":true}')});
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_SCHEMA_INVALID');
    await expect(app.getByText('2 decisions')).toBeVisible();

    await page.reload();
    await expect(app.getByText('2 decisions')).toBeVisible();
    const networkControl = 'http://127.0.0.1:8787/__test__/controller-network';
    expect((await request.post(networkControl, {data: {online: false}})).status()).toBe(204);
    try {
      await page.reload({waitUntil: 'domcontentloaded'});
      await expect(page.locator('#connectivity')).toContainText('Offline');
      await expect(app.getByText('2 decisions')).toBeVisible();
    } finally {
      expect((await request.post(networkControl, {data: {online: true}})).status()).toBe(204);
    }

    await page.goto('/?personal=1&role=viewer');
    await expect(page.locator('#role')).toHaveText('viewer');
    await expect(app.getByText('2 decisions')).toBeVisible();
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('2 decisions')).toBeVisible();

    const violations = await page.evaluate(() => ({
      unnamedButtons: [...document.querySelectorAll('button')].filter((button) => !button.textContent?.trim() && !button.getAttribute('aria-label')).length,
      duplicateIds: [...document.querySelectorAll('[id]')].map((node) => node.id).filter((id, index, ids) => ids.indexOf(id) !== index).length,
      landmarks: document.querySelectorAll('header, main, aside').length,
      unlabeledFileInputs: [...document.querySelectorAll('input[type=file]')].filter((input) => !input.id).length
    }));
    expect(violations).toEqual({unnamedButtons: 0, duplicateIds: 0, landmarks: 3, unlabeledFileInputs: 0});
  });
});
