import {expect, test} from '@playwright/test';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
const wasmCsp = process.env.SMALLFRAME_U_WASM_CSP ?? 'allow';

if (candidate === 'U' && wasmCsp === 'deny') {
  test('Candidate U fails closed when renderer CSP denies Wasm compilation', async ({page, request}) => {
    const reset = await request.post('http://127.0.0.1:8787/__test__/evidence/reset');
    expect(reset.status()).toBe(204);
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('Controller stopped: PRELUDE_WASM_STARTUP_FAILED. Local export remains available.', {timeout: 8_000});
    const host = page.locator('#app-host');
    await expect(host).toHaveAttribute('data-worker-state', 'stopped');
    await expect(host).toHaveAttribute('data-worker-generation', '1');
    await expect(host).toHaveAttribute('data-worker-restart-count', '0');
    await expect(host).toHaveAttribute('data-worker-stop-code', 'PRELUDE_WASM_STARTUP_FAILED');
    await expect(host).not.toHaveAttribute('data-worker-wasm-started', /./u);
    await expect(page.locator('#app-host iframe')).toHaveCount(0);
    await expect(page.frameLocator('iframe').getByText(/Decisions:/u)).toHaveCount(0);
    const rendererPaths = await page.evaluate(async () => {
      const paths = new Set<string>();
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          const path = new URL(request.url).pathname;
          if (/^\/runtime\/renderer\/[0-9a-f]{64}\.html$/u.test(path)) paths.add(path);
        }
      }
      return [...paths];
    });
    expect(rendererPaths).toHaveLength(1);
    const rendererPath = rendererPaths[0];
    const cachedCsp = await page.evaluate(async (path) => (await caches.match(path ?? ''))?.headers.get('content-security-policy') ?? '', rendererPath);
    expect(cachedCsp).not.toContain("'wasm-unsafe-eval'");
    const evidenceResponse = await request.get('http://127.0.0.1:8787/__test__/evidence/counts');
    const evidence = await evidenceResponse.json() as {http: number; ws: number; rendererFallback: {count: number}};
    expect(evidence).toMatchObject({http: 0, ws: 0, rendererFallback: {count: 0}});
  });
}
