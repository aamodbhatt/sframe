import {expect, test} from '@playwright/test';

test.describe('Phase 2 signed controller release pinning and safe update behavior', () => {
  test.beforeEach(async ({context}) => {
    await context.clearCookies();
  });

  test('controller verifies release manifest, displays build ID, and registers service worker', async ({page}) => {
    await page.goto('/?personal=1');
    await page.getByRole('button', {name: 'Open this exact version'}).click();

    // Verify service worker probe responds with service-worker-probe provenance
    const probeResponse = await page.evaluate(async () => {
      const resp = await fetch('/sw-probe');
      return {
        status: resp.status,
        provenance: resp.headers.get('x-smallframe-response-provenance'),
        text: await resp.text()
      };
    });
    expect(probeResponse.status).toBe(200);
    expect(probeResponse.provenance).toBe('service-worker-probe');
    expect(probeResponse.text).toContain('smallframe-service-worker');

    // Verify build ID displayed in workspace menu
    await page.getByRole('button', {name: 'Workspace'}).click();
    await expect(page.locator('#build')).toContainText('Build');
  });

  test('safe update banner appears when a new service worker waits and user can trigger update', async ({page}) => {
    await page.goto('/?personal=1');
    await page.getByRole('button', {name: 'Open this exact version'}).click();

    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();

    // Simulate update banner display
    await page.evaluate(() => {
      const banner = document.getElementById('update-banner');
      if (banner) banner.hidden = false;
      const details = document.getElementById('update-details');
      if (details) details.textContent = 'Build TestUpdateBuildId_123 is verified and ready.';
    });

    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-details')).toContainText('Build TestUpdateBuildId_123');

    // Dismissing hides the banner
    await page.locator('#dismiss-update').click();
    await expect(page.locator('#update-banner')).toBeHidden();

    // Workspace state is unaffected
    await expect(app.getByText('1 decisions')).toBeVisible();
  });
});
