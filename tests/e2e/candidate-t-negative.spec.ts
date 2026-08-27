import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const fixture = process.env.SMALLFRAME_T_FIXTURE ?? '';

if (candidate === 'T' && fixture) {
  test.beforeEach(async ({request}) => {
    const response = await request.post('/__test__/evidence/reset');
    expect(response.status()).toBe(204);
  });

  test(`Candidate T rejects bounded hostile fixture: ${fixture}`, async ({page, request}) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Decision Board');
    await expect(page.locator('#app-host iframe')).toHaveCount(1);
    await expect(page.locator('#status')).toContainText('Controller stopped', {timeout: 8_000});
    await expect(page.locator('h1')).toHaveText('Decision Board');
    const countsResponse = await request.get('/__test__/evidence/counts');
    expect(countsResponse.ok()).toBeTruthy();
    const counts = await countsResponse.json() as {http: number; ws: number; rendererFallback: {count: number}};
    expect(counts.http).toBe(0);
    expect(counts.ws).toBe(0);
    expect(counts.rendererFallback.count).toBe(0);
    console.log(JSON.stringify({fixture, status: await page.locator('#status').textContent(), canary: counts}));
  });
}
