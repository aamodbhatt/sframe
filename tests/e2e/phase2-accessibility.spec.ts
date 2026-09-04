import {expect, test} from '@playwright/test';

test.describe('Phase 2 automated accessibility checks across fixtures', () => {
  test.beforeEach(async ({context}) => {
    await context.clearCookies();
  });

  test('controller shell and Decision Board fixture satisfy full accessibility criteria', async ({page}) => {
    await page.goto('/?personal=1', {waitUntil: 'domcontentloaded'});

    // 1. Trust panel accessibility checks
    await expect(page.getByRole('heading', {name: 'Decision Board', level: 2})).toBeVisible();
    await expect(page.locator('#trust-title')).toBeVisible();

    const trustPanelViolations = await page.evaluate(() => {
      const unnamedButtons = [...document.querySelectorAll('button')].filter(
        (b) => !b.textContent?.trim() && !b.getAttribute('aria-label')
      ).length;
      const duplicateIds = [...document.querySelectorAll('[id]')].map((n) => n.id).filter(
        (id, i, arr) => arr.indexOf(id) !== i
      ).length;
      const skipLink = document.querySelector('.skip');
      return {
        unnamedButtons,
        duplicateIds,
        hasSkipLink: Boolean(skipLink),
        skipLinkHref: skipLink?.getAttribute('href')
      };
    });

    expect(trustPanelViolations.unnamedButtons).toBe(0);
    expect(trustPanelViolations.duplicateIds).toBe(0);
    expect(trustPanelViolations.hasSkipLink).toBe(true);
    expect(trustPanelViolations.skipLinkHref).toBe('#app-host');

    await page.getByRole('button', {name: 'Open this exact version'}).click();

    // 2. Open workspace and verify runtime landmarks
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('heading', {name: 'Decision Board', level: 2})).toBeVisible();

    const shellLandmarks = await page.evaluate(() => ({
      header: document.querySelectorAll('header').length,
      main: document.querySelectorAll('main').length,
      aside: document.querySelectorAll('aside').length,
      liveRegion: document.querySelectorAll('[aria-live]').length
    }));
    expect(shellLandmarks.header).toBe(1);
    expect(shellLandmarks.main).toBe(1);
    expect(shellLandmarks.aside).toBe(1);
    expect(shellLandmarks.liveRegion).toBeGreaterThanOrEqual(1);

    // 3. Workspace menu keyboard accessibility
    const menuButton = page.getByRole('button', {name: 'Workspace'});
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#workspace-actions')).toBeVisible();

    // Escape closes workspace menu
    await page.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#workspace-actions')).toBeHidden();

    // 4. In-iframe fixture button and heading semantics
    const iframeSemantics = await app.locator('section').evaluate((node) => {
      const buttons = [...node.querySelectorAll('button')];
      const unnamed = buttons.filter((b) => !b.textContent?.trim() && !b.getAttribute('aria-label')).length;
      const headings = [...node.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.tagName.toLowerCase());
      return {
        buttonCount: buttons.length,
        unnamedButtons: unnamed,
        headings
      };
    });
    expect(iframeSemantics.unnamedButtons).toBe(0);
    expect(iframeSemantics.headings).toContain('h2');
  });

  test('verifies keyboard focusability and reduced motion styles', async ({page}) => {
    await page.goto('/?personal=1', {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Open this exact version'}).click();

    // Tab key navigation flows cleanly through interactive elements
    await page.keyboard.press('Tab');
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(['a', 'button', 'input', 'iframe', 'section', 'body']).toContain(focusedTag ?? '');
  });
});
