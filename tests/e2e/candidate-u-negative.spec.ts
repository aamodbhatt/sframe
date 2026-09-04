import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const fixture = process.env.SMALLFRAME_U_FIXTURE ?? '';
const expectedCodes: Record<string, string> = {
  missing: 'APP_FACTORY_MISSING',
  'invalid-factory': 'APP_ABI_INVALID',
  duplicate: 'APP_DUPLICATE_REGISTRATION',
  thenable: 'APP_ASYNC_FACTORY',
  malformed: 'APP_ABI_INVALID',
  oversized: 'APP_DESCRIPTOR_TOO_LARGE',
  exception: 'CANDIDATE_U_TOP_LEVEL_EXCEPTION',
  'top-level': 'WORKER_READY_TIMEOUT',
  'hidden-key': 'APP_DESCRIPTOR_INVALID',
  'symbol-key': 'APP_DESCRIPTOR_INVALID',
  'accessor-result': 'APP_DESCRIPTOR_INVALID',
  'reentrant-caught': 'APP_REENTRANT_REGISTRATION',
  'named-array': 'WORKER_PROTOCOL_ERROR',
  nonfinite: 'WORKER_PROTOCOL_ERROR',
  'sparse-array': 'WORKER_PROTOCOL_ERROR',
  'array-accessor': 'WORKER_PROTOCOL_ERROR'
};

if (candidate === 'U' && fixture && fixture !== 'poison' && fixture !== 'syntax' && fixture !== 'global-forge') {
  test.beforeEach(async ({request}) => {
    const response = await request.post('/__test__/evidence/reset');
    expect(response.status()).toBe(204);
  });

  test(`Candidate U fail-stops hostile fixture with exact code: ${fixture}`, async ({page, request}) => {
    const expectedCode = expectedCodes[fixture];
    expect(expectedCode, `missing expected stop code for ${fixture}`).toBeTruthy();
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('h1')).toHaveText('Decision Board');
    await expect(page.locator('#status')).toHaveText(`Controller stopped: ${expectedCode}. Local export remains available.`, {timeout: 8_000});
    await expect(page.locator('#app-host iframe')).toHaveCount(0);
    const host = page.locator('#app-host');
    await expect(host).toHaveAttribute('data-worker-state', 'stopped');
    await expect(host).toHaveAttribute('data-worker-generation', '1');
    await expect(host).toHaveAttribute('data-worker-restart-count', '0');
    await expect(host).toHaveAttribute('data-worker-last-reason', expectedCode);
    await expect(host).toHaveAttribute('data-worker-stop-code', expectedCode);
    await expect(page.frameLocator('iframe').getByText(/Decisions:/u)).toHaveCount(0);

    const stableStatus = await page.locator('#status').textContent();
    await page.waitForTimeout(2_250);
    await expect(page.locator('#status')).toHaveText(stableStatus ?? '');
    await expect(host).toHaveAttribute('data-worker-generation', '1');
    await expect(host).toHaveAttribute('data-worker-restart-count', '0');
    await expect(host).toHaveAttribute('data-worker-state', 'stopped');

    const countsResponse = await request.get('/__test__/evidence/counts');
    expect(countsResponse.ok()).toBeTruthy();
    const counts = await countsResponse.json() as {http: number; ws: number; rendererFallback: {count: number}};
    expect(counts.http).toBe(0);
    expect(counts.ws).toBe(0);
    expect(counts.rendererFallback.count).toBe(0);
  });
}
