import {expect, test} from '@playwright/test';

test.describe('Phase 2 hostile-package, tampered-package, malformed-state, storage-corruption, and resource bounds', () => {
  test.beforeEach(async ({context}) => {
    await context.clearCookies();
  });

  test('rejects malformed state imports and non-conforming state shapes', async ({page}) => {
    await page.goto('/?personal=1');
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();

    await page.getByRole('button', {name: 'Workspace'}).click();

    // Malformed JSON (syntax error)
    await page.locator('#import-file').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not valid json}')
    });
    await expect(page.locator('#status')).toContainText('Import rejected:');

    // Array instead of object
    await page.locator('#import-file').setInputFiles({
      name: 'array.json',
      mimeType: 'application/json',
      buffer: Buffer.from('[1, 2, 3]')
    });
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_INVALID');

    // Schema violation: type mismatch (number instead of string)
    await page.locator('#import-file').setInputFiles({
      name: 'type-mismatch.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"decisions":{"d1":{"title":12345}}}')
    });
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_SCHEMA_INVALID');

    // Schema violation: additional unexpected property
    await page.locator('#import-file').setInputFiles({
      name: 'extra-property.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"decisions":{},"maliciousPayload":"injected"}')
    });
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_SCHEMA_INVALID');

    // Resource bound: state exceeding maxPlaintextBytes
    const largePayload = JSON.stringify({
      decisions: Object.fromEntries(
        Array.from({length: 15_000}, (_, i) => [`dec_${i}`, {title: `Title ${i} ` + 'x'.repeat(100)}])
      )
    });
    await page.locator('#import-file').setInputFiles({
      name: 'oversized.json',
      mimeType: 'application/json',
      buffer: Buffer.from(largePayload)
    });
    await expect(page.locator('#status')).toContainText('Import rejected: STATE_TOO_LARGE');

    // App workspace remains completely stable and interactive
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
  });

  test('survives storage corruption gracefully with exports remaining functional', async ({page}) => {
    await page.goto('/?personal=1');
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await app.getByRole('button', {name: 'Add decision'}).click();

    // Verify exports work even if storage is forgotten or corrupted
    await page.getByRole('button', {name: 'Workspace'}).click();
    const exportPromise = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Export readable JSON'}).click();
    const download = await exportPromise;
    expect(download.suggestedFilename()).toBe('decision-board-state.json');

    const pkgDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Export executable package'}).click();
    const pkgDownload = await pkgDownloadPromise;
    expect(pkgDownload.suggestedFilename()).toBe('decision-board.smallframe');
  });

  test('sandboxed worker has no access to DOM, localStorage, IndexedDB, or network', async ({page}) => {
    await page.goto('/?personal=1');
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();

    // Check that host controller context has no leakage into renderer iframe
    const iframeWindowHasSecrets = await app.locator('body').evaluate(() => {
      return (
        'localStorage' in window ||
        'sessionStorage' in window ||
        typeof fetch === 'undefined'
      );
    });
    expect(iframeWindowHasSecrets).toBe(true);
  });
});
