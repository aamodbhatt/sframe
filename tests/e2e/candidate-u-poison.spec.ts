import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const fixture = process.env.SMALLFRAME_U_FIXTURE ?? '';

if (candidate === 'U' && (fixture === 'poison' || fixture === 'global-forge')) {
  test(`Candidate U remains authoritative after contained publisher attack: ${fixture}`, async ({page, request}) => {
    const reset = await request.post('/__test__/evidence/reset');
    expect(reset.status()).toBe(204);
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('App Worker running');
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-state', 'running');
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-generation', '1');
    await expect(page.frameLocator('iframe').getByText('Lexical isolation: 15/15')).toBeVisible();
    await expect(page.frameLocator('iframe').getByText('Authority probes: 9/9')).toBeVisible();
    await expect(page.frameLocator('iframe').getByText('LEXICAL_AUTHORITY_LEAK')).toHaveCount(0);
    await expect(page.frameLocator('iframe').getByText('AUTHORITY_PROBE_ESCAPE')).toHaveCount(0);
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-generation', '1');
    const evidenceResponse = await request.get('/__test__/evidence/counts');
    const evidence = await evidenceResponse.json() as {http: number; ws: number; rendererFallback: {count: number}};
    expect(evidence.http).toBe(0);
    expect(evidence.ws).toBe(0);
    expect(evidence.rendererFallback.count).toBe(0);
  });
}
