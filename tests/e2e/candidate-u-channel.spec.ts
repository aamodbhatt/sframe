import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const fixture = process.env.SMALLFRAME_U_CHANNEL_FIXTURE ?? '';
const expectedErrors: Record<string, string> = {
  'controller-replay': 'CHANNEL_SEQUENCE_REPLAY',
  'controller-wrong-session': 'CHANNEL_SESSION_INVALID',
  'controller-extra-key': 'CHANNEL_MESSAGE_SCHEMA',
  'controller-unknown-type': 'CHANNEL_MESSAGE_SCHEMA',
  'controller-oversized': 'CHANNEL_MESSAGE_TOO_LARGE',
  'controller-transfer': 'CHANNEL_TRANSFER_FORBIDDEN',
  'renderer-replay': 'CHANNEL_SEQUENCE_REPLAY',
  'renderer-wrong-session': 'CHANNEL_SESSION_INVALID',
  'renderer-extra-key': 'CHANNEL_MESSAGE_SCHEMA',
  'renderer-unknown-type': 'CHANNEL_MESSAGE_SCHEMA',
  'renderer-oversized': 'CHANNEL_MESSAGE_TOO_LARGE',
  'renderer-transfer': 'CHANNEL_TRANSFER_FORBIDDEN',
  'renderer-duplicate-ready': 'CHANNEL_MESSAGE_SCHEMA',
  'worker-inbound-replay': 'WORKER_MESSAGE_REPLAY',
  'worker-outbound-replay': 'WORKER_PROTOCOL_ENVELOPE_INVALID',
  'worker-outbound-nonobject': 'WORKER_PROTOCOL_ENVELOPE_INVALID'
};

if (candidate === 'U' && fixture) {
  test.beforeEach(async ({request}) => {
    const response = await request.post('/__test__/evidence/reset');
    expect(response.status()).toBe(204);
  });

  if (fixture === 'ready-schema-extra' || fixture === 'ready-port') {
    test('Candidate U rejects a ready handshake with an extra field', async ({page}) => {
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText('Controller stopped: RENDERER_HANDSHAKE_TIMEOUT. Local export remains available.', {timeout: 8_000});
      await expect(page.frameLocator('iframe').getByText(/Decisions:/u)).toHaveCount(0);
      await expect(page.locator('#app-host iframe')).toHaveCount(0);
    });
  } else if (fixture === 'init-schema-extra' || fixture === 'init-oversized') {
    test(`Candidate U rejects the invalid init envelope: ${fixture}`, async ({page}) => {
      const expected = fixture === 'init-oversized' ? 'INIT_MESSAGE_TOO_LARGE' : 'RENDERER_INIT_TIMEOUT';
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(`Controller stopped: ${expected}. Local export remains available.`, {timeout: 8_000});
      await expect(page.locator('#app-host iframe')).toHaveCount(0);
    });
  } else if (fixture === 'window-init-replay') {
    test('Candidate U consumes exactly one init and ignores the replayed window message', async ({page}) => {
      await page.goto('/');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-state', 'running');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-generation', '1');
      await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
      await page.waitForTimeout(750);
      await expect(page.locator('#app-host')).not.toHaveAttribute('data-replayed-init-accepted', 'true');
      await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
      await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
      await expect(page.locator('#status')).not.toHaveAttribute('data-state', 'error');
    });
  } else {
    test(`Candidate U fail-closes the injected channel violation: ${fixture}`, async ({page, request}) => {
      const expectedError = expectedErrors[fixture];
      expect(expectedError, `missing expected error for ${fixture}`).toBeTruthy();
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(`Controller stopped: ${expectedError}. Local export remains available.`, {timeout: 8_000});
      const stableStatus = await page.locator('#status').textContent();
      await page.waitForTimeout(750);
      await expect(page.locator('#status')).toHaveText(stableStatus ?? '');
      await expect(page.locator('#app-host iframe')).toHaveCount(0);
      if (!fixture.startsWith('renderer-')) {
        const host = page.locator('#app-host');
        await expect(host).toHaveAttribute('data-worker-state', 'stopped');
        await expect(host).toHaveAttribute('data-worker-stop-code', expectedError);
      }
      const evidenceResponse = await request.get('/__test__/evidence/counts');
      expect(evidenceResponse.ok()).toBeTruthy();
      const evidence = await evidenceResponse.json() as {http: number; ws: number; rendererFallback: {count: number}};
      expect(evidence.http).toBe(0);
      expect(evidence.ws).toBe(0);
      expect(evidence.rendererFallback.count).toBe(0);
    });
  }
}
