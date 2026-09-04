import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const mutated = process.env.SMALLFRAME_T_MUTATE_RENDERER === '1';

if (candidate === 'T' && mutated) {
  test('Candidate T rejects a one-byte mutated renderer before execution', async ({page, request}) => {
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('h1')).toHaveText('Decision Board');
    await expect(page.locator('#status')).toContainText('Controller stopped', {timeout: 8_000});
    await expect(page.locator('#app-host iframe')).toHaveCount(0);
    const evidenceResponse = await request.get('/__test__/evidence/counts');
    expect(evidenceResponse.ok()).toBeTruthy();
    const evidence = await evidenceResponse.json() as {rendererMutation: {count: number; paths: string[]}; http: number; ws: number};
    expect(evidence.rendererMutation.count).toBeGreaterThan(0);
    expect(evidence.http).toBe(0);
    expect(evidence.ws).toBe(0);
    console.log(JSON.stringify({tamper: 'renderer-one-byte', evidence}));
  });
}
