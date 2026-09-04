import {chromium, expect, firefox, test, webkit} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {WebSocket as NodeWebSocket} from 'ws';

const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'U';
const usesClassicWorker = candidate === 'S' || candidate === 'T' || candidate === 'U';
const usesCandidateTFraming = candidate === 'T' || candidate === 'U';
const phase0WasmArtifact = candidate === 'U' ? readFileSync(join(process.cwd(), 'target', 'wasm32-unknown-unknown', 'release', 'smallframe_phase0_wasm.wasm')) : Buffer.alloc(0);
const phase0WasmDigest = createHash('sha256').update(phase0WasmArtifact).digest('hex');
const phase1WasmArtifact = candidate === 'U' ? readFileSync(join(process.cwd(), 'target', 'phase1-wasm', 'smallframe_verifier_bg.wasm')) : Buffer.alloc(0);
const phase1WasmDigest = createHash('sha256').update(phase1WasmArtifact).digest('hex');
const phase1PackageVector = candidate === 'U' ? readFileSync(join(process.cwd(), 'packages', 'protocol', 'vectors', 'canonical-package-v1.zip.b64'), 'utf8').trim() : '';
type PageLike = Parameters<Parameters<typeof test>[1]>[0]['page'];

test.beforeEach(async ({request}) => {
  const response = await request.post('http://127.0.0.1:8787/__test__/evidence/reset');
  expect(response.status()).toBe(204);
});

const evidenceCounts = async (request: Parameters<Parameters<typeof test>[1]>[0]['request']) => {
  const response = await request.get('http://127.0.0.1:8787/__test__/evidence/counts');
  expect(response.ok()).toBeTruthy();
  return await response.json() as {
    http: number;
    ws: number;
    paths: string[];
    rendererFallback: {count: number; paths: string[]};
    appNetwork: {count: number; paths: string[]};
    serviceWorkerRequests: Array<{target: string; pathname: string; search: string; method: string; destination: string; status: number}>;
  };
};

const rendererResponse = (page: PageLike): Promise<Awaited<ReturnType<typeof page.waitForResponse>> | null> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 10_000);
  void page.waitForResponse((response) => response.url().includes('/runtime/renderer/')).then((response) => {
    clearTimeout(timer);
    resolve(response);
  }).catch(() => resolve(null));
});

const rendererPathFrom = async (page: PageLike): Promise<string> => {
  const path = await page.locator('iframe').getAttribute('data-renderer-path');
  if (!path) throw new Error('renderer iframe path was not recorded');
  return path;
};

const parseCsp = (value: string): Map<string, string[]> => {
  const directives = new Map<string, string[]>();
  for (const raw of value.split(';')) {
    const tokens = raw.trim().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0] as string;
    if (directives.has(name)) throw new Error(`duplicate CSP directive: ${name}`);
    directives.set(name, tokens.slice(1));
  }
  return directives;
};
const expectedServiceWorkerCsp = parseCsp("default-src 'none'; script-src 'self'; connect-src http://app.localhost:4173/runtime/renderer/ http://app.localhost:4173/index.html http://app.localhost:4173/main.js http://app.localhost:4173/personal-store.js http://app.localhost:4173/personal-runtime.js http://app.localhost:4173/shared-store.js http://app.localhost:4173/shared-runtime.js http://app.localhost:4173/state-worker.js http://app.localhost:4173/fixture-module.js http://app.localhost:4173/controller.css http://app.localhost:4173/manifest.webmanifest http://app.localhost:4173/icon.svg http://app.localhost:4173/release.json; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors 'none'");

const evidenceFor = async (page: PageLike, path: string) => page.evaluate(async (rendererPath) => {
  const controller = navigator.serviceWorker.controller;
  const probe = await fetch('/sw-probe', {cache: 'no-store'});
  const cacheNames = await caches.keys();
  const cached = await caches.match(rendererPath);
  let cachedDigest: string | null = null;
  if (cached) {
    const digest = await crypto.subtle.digest('SHA-256', await cached.clone().arrayBuffer());
    cachedDigest = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return {
    controllerScriptUrl: controller?.scriptURL ?? null,
    cacheNames,
    cachePresent: cached !== null,
    cachedDigest,
    cachedCsp: cached?.headers.get('content-security-policy') ?? null,
    cachedProvenance: cached?.headers.get('x-smallframe-response-provenance') ?? null,
    probeStatus: probe.status,
    probeBody: await probe.text(),
    probeProvenance: probe.headers.get('x-smallframe-response-provenance')
  };
}, path);

test('Phase 0 response provenance and verified-cache evidence', async ({page, request}) => {
  const responsePromise = candidate === 'A' ? Promise.resolve(null) : rendererResponse(page);
  await page.goto('/', {waitUntil: 'domcontentloaded'});
  await expect(page.locator('#build')).toContainText('Verified renderer');
  const rendererPath = await rendererPathFrom(page);
  const rendererResponseValue = await responsePromise;
  if (candidate !== 'A') expect(rendererResponseValue).not.toBeNull();
  const responseHeaders = rendererResponseValue?.headers() ?? {};
  const evidence = await evidenceFor(page, rendererPath);

  expect(evidence.controllerScriptUrl).toBe('http://app.localhost:4173/sw.js');
  expect(evidence.cachePresent).toBeTruthy();
  expect(evidence.cachedDigest).toBe(rendererPath.split('/').at(-1)?.replace('.html', ''));
  expect(evidence.cachedCsp).toContain("connect-src 'none'");
  expect(evidence.cachedCsp).toContain('sandbox allow-scripts');
  if (candidate === 'U') {
    const scriptSources = parseCsp(evidence.cachedCsp ?? '').get('script-src') ?? [];
    expect(scriptSources.filter((source) => source === "'wasm-unsafe-eval'")).toHaveLength(1);
    expect(scriptSources).not.toContain("'unsafe-eval'");
  }
  expect(evidence.cachedProvenance).toBe('service-worker-cache');
  expect(evidence.probeStatus).toBe(200);
  expect(evidence.probeBody).toContain('smallframe-service-worker:');
  expect(evidence.probeProvenance).toBe('service-worker-probe');

  const directNetwork = await request.get(`http://app.localhost:4173${rendererPath}`);
  expect(directNetwork.headers()['x-smallframe-response-provenance']).toBe('network-fallback');
  expect(directNetwork.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  if (usesCandidateTFraming) {
    const controller = await request.get('/');
    const controllerCsp = controller.headers()['content-security-policy'] ?? '';
    expect(parseCsp(controllerCsp).get('frame-src')).toEqual(['http://app.localhost:4173/runtime/renderer/', 'http://app.localhost:4173/sw.js']);
  }
  if (candidate !== 'A') {
    expect(responseHeaders['x-smallframe-response-provenance']).toBe(candidate === 'R' || usesClassicWorker ? 'service-worker-cache' : 'network-fallback');
    expect(responseHeaders['content-security-policy']).toContain(candidate === 'R' || usesClassicWorker ? 'sandbox allow-scripts' : "frame-ancestors 'none'");
  }
});

test('Phase 1 production Wasm verifies the native canonical package vector', async ({page}) => {
  test.skip(candidate !== 'U', 'Phase 1 verifier is Candidate U only');
  await page.goto('/', {waitUntil: 'domcontentloaded'});
  await expect(page.locator('#status')).toContainText('App Worker running', {timeout: 8_000});
  const renderer = page.frames().find((frame) => frame.url().includes('/runtime/renderer/'));
  expect(renderer).toBeDefined();
  const results = await renderer!.evaluate(({archiveBase64, packageDigest, publisherKeyId}) => {
    const glue = (globalThis as typeof globalThis & {__smallframePhase1Verifier?: {wasm_verify_package: (archive: Uint8Array, expectedDigest: string, expectedKeyId: string) => string}}).__smallframePhase1Verifier;
    if (!glue) throw new Error('PHASE1_VERIFIER_NOT_READY');
    const archive = Uint8Array.from(atob(archiveBase64), (character) => character.charCodeAt(0));
    return {
      valid: JSON.parse(glue.wasm_verify_package(archive, packageDigest, publisherKeyId)) as unknown,
      wrongPin: JSON.parse(glue.wasm_verify_package(archive, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', publisherKeyId)) as unknown
    };
  }, {
    archiveBase64: phase1PackageVector,
    packageDigest: 'xGzOKkefgzfEFU-AFvSM4zHn9bw-XF3xwlHoz-QHJAA',
    publisherKeyId: 'sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk'
  });
  expect(results.valid).toEqual({
    ok: true,
    packageDigest: 'xGzOKkefgzfEFU-AFvSM4zHn9bw-XF3xwlHoz-QHJAA',
    artifactDigest: 'O0lEC4tH1tN_ncCX_FalC8uNSyxOpSRvFUU59BLbr5E',
    publisherKeyId: 'sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk'
  });
  expect(results.wrongPin).toEqual({ok: false, error: {code: 'PACKAGE_DIGEST_MISMATCH'}});
});

if (usesCandidateTFraming) {
  test(`Candidate ${candidate} exact Service Worker frame-source compatibility and fail-closed negatives`, async ({page, request}) => {
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#build')).toContainText('Verified renderer');
    const paths = [
      {path: '/sw.js', status: 200},
      {path: '/sw.js?query=1', status: 404},
      {path: '/%73w.js', status: 404},
      {path: '/%73w%2Ejs', status: 404},
      {path: '/sw.js/suffix', status: 404},
      {path: '/sw.js%2Fescape', status: 404},
      {path: '/sw.js?status=500', status: 500},
      {path: '/sw.js?redirect=1', status: 302}
    ];
    for (const {path, status} of paths) {
      const response = await request.get(path, {maxRedirects: 0});
      const headers = response.headers();
      const responseCsp = parseCsp(headers['content-security-policy'] ?? '');
      expect([...responseCsp.entries()]).toEqual([...expectedServiceWorkerCsp.entries()]);
      const headerArray = response.headersArray();
      for (const name of ['content-security-policy', 'content-type', 'x-content-type-options']) {
        expect(headerArray.filter((entry) => entry.name.toLowerCase() === name)).toHaveLength(1);
      }
      expect(headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(response.url()).toBe(`http://app.localhost:4173${path}`);
      expect(response.status()).toBe(status);
      if (status === 302) expect(headers.location).toBe('/sw.js');
    }
    const direct = await request.get(await rendererPathFrom(page));
    expect(direct.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    await page.evaluate(() => {
      const sources = [
        '/sw.js',
        '/sw.js?query=1',
        '/%73w.js?probe=encoded-s',
        '/%73w%2Ejs?probe=encoded-dot',
        '/sw.js/suffix?probe=suffix',
        '/sw.js%2Fescape?probe=encoded-slash',
        '/sw.js?status=500',
        '/sw.js?redirect=1'
      ];
      for (const src of sources) {
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.dataset.probe = src;
        iframe.addEventListener('load', () => { iframe.dataset.outcome = 'load'; }, {once: true});
        iframe.addEventListener('error', () => { iframe.dataset.outcome = 'error'; }, {once: true});
        document.body.appendChild(iframe);
      }
    });
    await expect(page.locator('iframe[data-probe]')).toHaveCount(8);
    await expect.poll(async () => {
      const evidence = await evidenceCounts(request);
      const iframeRequests = evidence.serviceWorkerRequests.filter((entry) => entry.destination === 'iframe');
      return {
        exact: iframeRequests.some((entry) => entry.search === '' && entry.status === 200),
        query: iframeRequests.some((entry) => entry.search === '?query=1' && entry.status === 404),
        encodedS: iframeRequests.some((entry) => entry.search === '?probe=encoded-s' && entry.status === 404),
        encodedDot: iframeRequests.some((entry) => entry.search === '?probe=encoded-dot' && entry.status === 404),
        failure: iframeRequests.some((entry) => entry.search === '?status=500' && entry.status === 500),
        redirect: iframeRequests.some((entry) => entry.search === '?redirect=1' && entry.status === 302)
      };
    }).toEqual({exact: true, query: true, encodedS: true, encodedDot: true, failure: true, redirect: true});
    const evidence = await evidenceCounts(request);
    for (const {path, status} of paths) expect(evidence.serviceWorkerRequests.some((entry) => entry.target === path && entry.status === status)).toBe(true);
    expect(evidence.serviceWorkerRequests.some((entry) => entry.search === '?probe=suffix' && entry.destination === 'iframe')).toBe(false);
    expect(evidence.serviceWorkerRequests.some((entry) => entry.search === '?probe=encoded-slash' && entry.destination === 'iframe')).toBe(false);
    const frameExposure = await page.locator('iframe[data-probe]').evaluateAll((frames) => frames.map((frame) => {
      const iframe = frame as HTMLIFrameElement;
      const document = iframe.contentDocument;
      return {
        probe: iframe.dataset.probe,
        exposedResponseDocument: Boolean(document?.documentElement && ((document.body?.textContent?.trim().length ?? 0) > 0 || (document.body?.childElementCount ?? 0) > 0))
      };
    }));
    expect(frameExposure).toHaveLength(8);
    expect(frameExposure.every((entry) => entry.exposedResponseDocument === false)).toBe(true);
    expect(evidence.rendererFallback.count).toBe(0);
  });
}

test('renderer boundary, channel, and canary behavior', async ({page, request}) => {
  if (candidate === 'U') {
    const httpPositiveControl = await request.get('http://127.0.0.1:8790/canary-positive-control');
    expect(httpPositiveControl.status()).toBe(204);
    await new Promise<void>((resolve, reject) => {
      const socket = new NodeWebSocket('ws://127.0.0.1:8791/canary');
      socket.once('open', () => socket.close());
      socket.once('close', () => resolve());
      socket.once('error', reject);
    });
    const canaryPositiveControl = await request.get('http://127.0.0.1:8790/counts');
    expect(await canaryPositiveControl.json()).toMatchObject({http: 1, ws: 1});
    const reset = await request.post('http://127.0.0.1:8787/__test__/evidence/reset');
    expect(reset.status()).toBe(204);
  }
  const responsePromise = candidate === 'A' ? Promise.resolve(null) : rendererResponse(page);
  await page.goto('/#phase0-secret-fixture');
  const rendererPath = await rendererPathFrom(page);
  const response = await responsePromise;
  if (candidate !== 'A') expect(response).not.toBeNull();
  expect(await page.evaluate(() => location.hash)).toBe(candidate === 'U' ? '' : '#phase0-secret-fixture');
  expect(await page.title()).not.toContain('phase0-secret-fixture');

  const frame = page.locator('iframe');
  if (candidate === 'R' || usesClassicWorker || candidate === 'A') {
    if (candidate === 'R' || usesClassicWorker) await expect(frame).not.toHaveAttribute('sandbox', /./u);
    else await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect.poll(() => page.frames().some((item) => item !== page.mainFrame() && (candidate === 'A' ? item.url().startsWith('about:srcdoc') : item.url().includes('/runtime/renderer/')))).toBe(true);
    const rendererFrame = page.frames().find((item) => item !== page.mainFrame() && (candidate === 'A' ? item.url().startsWith('about:srcdoc') : item.url().includes('/runtime/renderer/')));
    if (!rendererFrame) throw new Error('renderer frame missing');
    if (candidate === 'A') {
      const srcdocEvidence = await rendererFrame.evaluate(() => ({firstHeadElement: document.head.firstElementChild?.tagName ?? null, firstHeadHttpEquiv: document.head.firstElementChild?.getAttribute('http-equiv') ?? null, metaCsp: document.head.firstElementChild?.getAttribute('content') ?? null}));
      expect(srcdocEvidence.firstHeadElement).toBe('META');
      expect(srcdocEvidence.firstHeadHttpEquiv).toBe('Content-Security-Policy');
      expect(srcdocEvidence.metaCsp).toContain("connect-src 'none'");
      expect(srcdocEvidence.metaCsp).not.toContain('sandbox');
      expect(srcdocEvidence.metaCsp).not.toContain('frame-ancestors');
    }
    await expect(page.locator('#status')).toContainText('App Worker running');
    await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
    if (usesClassicWorker) {
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-kind', 'classic-blob');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-blob-count', '1');
    }
    if (candidate !== 'A') expect(rendererFrame.url()).not.toContain('#');
    const boundary = await rendererFrame.evaluate(async () => {
      const result: Record<string, unknown> = {selfOrigin: self.origin, locationOrigin: location.origin, locationHref: location.href, parentDomRead: false, parentDomWrite: false};
      try { void window.parent.document; result.parentDomRead = true; } catch (_) {}
      try { window.parent.document.title = 'forged'; result.parentDomWrite = true; } catch (_) {}
      result.domain = (() => { const value = document.domain; let setterThrows = false; try { document.domain = 'app.localhost'; } catch (_) { setterThrows = true; } return {value, setterThrows}; })();
      result.cookie = (() => { let read = ''; let readThrows = false; let writeThrows = false; try { read = document.cookie; } catch (_) { readThrows = true; } try { document.cookie = '__smallframe_probe__=1'; } catch (_) { writeThrows = true; } return {read, readThrows, writeThrows}; })();
      result.localStorageBlocked = await (async () => { try { localStorage.setItem('__smallframe_probe__', 'x'); localStorage.removeItem('__smallframe_probe__'); return false; } catch (_) { return true; } })();
      result.sessionStorageBlocked = await (async () => { try { sessionStorage.setItem('__smallframe_probe__', 'x'); sessionStorage.removeItem('__smallframe_probe__'); return false; } catch (_) { return true; } })();
      result.indexedDbBlocked = await (async () => { try { const request = indexedDB.open('__smallframe_probe__'); request.onupgradeneeded = () => request.result.close(); await Promise.race([new Promise<void>((resolve) => { request.onerror = () => resolve(); request.onsuccess = () => { request.result.close(); resolve(); }; }), new Promise<void>((resolve) => setTimeout(resolve, 500))]); return request.error !== null; } catch (_) { return true; } })();
      result.cacheStorageBlocked = await (async () => { try { await caches.open('__smallframe_probe__'); return false; } catch (_) { return true; } })();
      result.opfsBlocked = await (async () => { try { if (!navigator.storage?.getDirectory) return true; await navigator.storage.getDirectory(); return false; } catch (_) { return true; } })();
      result.serviceWorker = await (async () => { if (!('serviceWorker' in navigator)) return {available: false, getRegistrationRejected: true, registerRejected: true}; let getRegistrationRejected = false; let registerRejected = false; try { await navigator.serviceWorker.getRegistration(); } catch (_) { getRegistrationRejected = true; } try { await navigator.serviceWorker.register('/sw.js'); } catch (_) { registerRejected = true; } return {available: true, getRegistrationRejected, registerRejected}; })();
      result.broadcastChannel = await (async () => { try { const channel = new BroadcastChannel('__smallframe_probe__'); channel.close(); return {constructed: true}; } catch (_) { return {constructed: false}; } })();
      result.nestedWorker = await (async () => { try { const url = URL.createObjectURL(new Blob(['postMessage("nested-worker")'], {type: 'text/javascript'})); const worker = new Worker(url); const message = await new Promise<string>((resolve) => { worker.onmessage = (event) => resolve(String(event.data)); setTimeout(() => resolve('timeout'), 500); }); worker.terminate(); URL.revokeObjectURL(url); return {constructed: true, message}; } catch (error) { return {constructed: false, error: error instanceof Error ? error.name : 'unknown'}; } })();
      result.sharedWorker = await (async () => { try { const url = URL.createObjectURL(new Blob(['onconnect = (event) => event.ports[0].postMessage("shared-worker")'], {type: 'text/javascript'})); const worker = new SharedWorker(url); const message = await new Promise<string>((resolve) => { worker.port.onmessage = (event) => resolve(String(event.data)); worker.port.start(); setTimeout(() => resolve('timeout'), 500); }); worker.port.close(); URL.revokeObjectURL(url); return {constructed: true, message}; } catch (error) { return {constructed: false, error: error instanceof Error ? error.name : 'unknown'}; } })();
      result.fetch = await (async () => { const attempt = async (credentials: RequestCredentials) => { try { await fetch('http://localhost:8790/canary?source=renderer', {credentials}); return 'resolved'; } catch (_) { return 'rejected'; } }; return {omit: await attempt('omit'), include: await attempt('include')}; })();
      return result;
    });
    expect(boundary.selfOrigin).toBe('null');
    expect(boundary.locationOrigin).toBe('http://app.localhost:4173');
    expect(String(boundary.locationHref)).toContain('/runtime/renderer/');
    expect(boundary.parentDomRead).toBe(false);
    expect(boundary.parentDomWrite).toBe(false);
    expect((boundary.domain as {value: string; setterThrows: boolean}).value).toBe('');
    expect((boundary.domain as {value: string; setterThrows: boolean}).setterThrows).toBe(true);
    expect((boundary.cookie as {read: string; readThrows: boolean; writeThrows: boolean}).readThrows || (boundary.cookie as {read: string; readThrows: boolean; writeThrows: boolean}).read === '').toBe(true);
    expect(boundary.localStorageBlocked).toBe(true);
    expect(boundary.sessionStorageBlocked).toBe(true);
    expect(boundary.indexedDbBlocked).toBe(true);
    expect(boundary.cacheStorageBlocked).toBe(true);
    expect(boundary.opfsBlocked).toBe(true);
    expect((boundary.serviceWorker as {getRegistrationRejected: boolean; registerRejected: boolean}).getRegistrationRejected).toBe(true);
    expect((boundary.serviceWorker as {getRegistrationRejected: boolean; registerRejected: boolean}).registerRejected).toBe(true);
    expect((boundary.fetch as {omit: string; include: string}).omit).toBe('rejected');
    expect((boundary.fetch as {omit: string; include: string}).include).toBe('rejected');
    const controllerBoundary = await page.evaluate(() => {
      const current = document.querySelector('iframe');
      let documentReadThrows = false;
      try { void current?.contentWindow?.document; } catch (_) { documentReadThrows = true; }
      return {contentDocumentNull: current?.contentDocument === null, documentReadThrows, rendererOrigin: document.getElementById('app-host')?.getAttribute('data-renderer-origin')};
    });
    expect(controllerBoundary.contentDocumentNull).toBe(true);
    expect(controllerBoundary.documentReadThrows).toBe(true);
    expect(controllerBoundary.rendererOrigin).toBe('null');
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-self-origin', 'null');
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-location-origin', 'null');
    await expect(page.locator('#app-host')).toHaveAttribute('data-worker-location-href', /^blob:null\//u);
    if (usesCandidateTFraming) {
    const broadcastName = `smallframe-cross-context-${Date.now()}-${Math.random()}`;
    const controllerBroadcast = page.evaluate(async (name) => new Promise<boolean>((resolve) => {
      const channel = new BroadcastChannel(name);
      let received = false;
      const onWindowMessage = (event: MessageEvent) => {
        if (event.source === document.querySelector('iframe')?.contentWindow && event.data?.type === 'broadcast-ready') channel.postMessage('from-controller');
      };
      window.addEventListener('message', onWindowMessage);
      channel.onmessage = (event) => { if (event.data === 'from-renderer') received = true; };
      window.setTimeout(() => { window.removeEventListener('message', onWindowMessage); channel.close(); resolve(received); }, 300);
    }), broadcastName);
    const rendererBroadcast = rendererFrame.evaluate(async (name) => {
      const channel = new BroadcastChannel(name);
      let received = false;
      channel.onmessage = (event) => { if (event.data === 'from-controller') received = true; };
      window.parent.postMessage({type: 'broadcast-ready'}, '*');
      channel.postMessage('from-renderer');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      channel.close();
      return received;
    }, broadcastName);
    expect((await Promise.all([controllerBroadcast, rendererBroadcast]))[0]).toBe(false);
    expect((await Promise.all([controllerBroadcast, rendererBroadcast]))[1]).toBe(false);
    }
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
  } else {
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.locator('#status')).not.toContainText('App Worker running');
  }

  const counts = await evidenceCounts(request);
  expect(counts.http).toBe(0);
  expect(counts.ws).toBe(0);
  expect(counts.rendererFallback.count).toBe(0);
  expect(rendererPath).toMatch(/^\/runtime\/renderer\/[0-9a-f]{64}\.html$/u);
});

test('verified renderer transport-offline reopen', async ({browserName, page: fixturePage, request}, testInfo) => {
  if (candidate === 'U') {
    const page = fixturePage;
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#status')).toContainText('App Worker running');
    await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
    const rendererPath = await rendererPathFrom(page);
    const beforeOffline = await evidenceCounts(request);
    const networkControl = 'http://127.0.0.1:8787/__test__/controller-network';
    const stopped = await request.post(networkControl, {data: {online: false}});
    expect(stopped.status()).toBe(204);
    try {
      let positiveControlFailed = false;
      try { await request.get(`http://127.0.0.1:4173${rendererPath}`, {timeout: 1_500}); }
      catch (_) { positiveControlFailed = true; }
      expect(positiveControlFailed).toBe(true);
      const cachedNavigation = page.waitForResponse((response) => response.url() === `http://app.localhost:4173${rendererPath}`);
      await page.evaluate(async () => {
        const reopen = (window as Window & {__smallframePhase0ReopenRenderer?: () => Promise<void>}).__smallframePhase0ReopenRenderer;
        if (!reopen) throw new Error('PHASE0_REOPEN_HOOK_MISSING');
        await reopen();
      });
      const cachedResponse = await cachedNavigation;
      expect(cachedResponse.status()).toBe(200);
      // Playwright WebKit does not attribute this synthetic navigation through
      // Response.fromServiceWorker(); the origin is physically unbound, so the
      // provenance header and zero network delta are the causal oracle there.
      if (browserName !== 'webkit') expect(cachedResponse.fromServiceWorker()).toBe(true);
      expect(cachedResponse.headers()['x-smallframe-response-provenance']).toBe('service-worker-cache');
      await expect(page.locator('#status')).toContainText('App Worker running', {timeout: 8_000});
      await expect(page.frameLocator('iframe').getByText('Role: editor · Online')).toBeVisible();
      await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
      const evidence = await evidenceCounts(request);
      expect(evidence.rendererFallback.count).toBe(beforeOffline.rendererFallback.count);
      expect(evidence.appNetwork.count).toBe(beforeOffline.appNetwork.count);
      expect(evidence.http).toBe(0);
      expect(evidence.ws).toBe(0);
    } finally {
      const restarted = await request.post(networkControl, {data: {online: true}});
      expect(restarted.status()).toBe(204);
    }
    return;
  }
  const browserType = ({chromium, firefox, webkit} as const)[browserName];
  const context = await browserType.launchPersistentContext(testInfo.outputPath('persistent-profile'), {headless: true, serviceWorkers: 'allow'});
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    const firstRenderer = page.locator('iframe');
    await expect(firstRenderer).toHaveCount(1);
    if (candidate === 'T') {
      await expect(page.locator('#status')).toContainText('App Worker running');
      await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
      await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
      await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
      const faultToken = `${Date.now()}-${Math.random().toString(36).slice(2)}-renderer`;
      const fault = await page.request.post('/__test__/renderer-fault', {data: {token: faultToken}});
      expect(fault.status()).toBe(204);
      await context.addCookies([{name: 'smallframe-renderer-fault', value: faultToken, domain: 'app.localhost', path: '/'}]);
    }
    await page.reload();
    if (candidate === 'R' || candidate === 'A' || candidate === 'S' || candidate === 'T') {
      await expect(page.locator('#status')).toContainText('App Worker running');
      if (candidate === 'S' || candidate === 'T') {
        await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
        await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
        await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
      }
      const offlineEvidence = await evidenceCounts(page.request);
      expect(offlineEvidence.rendererFallback.count).toBe(0);
      console.log(JSON.stringify({test: 'persistent-profile warm renderer-offline reopen', rendererFallback: offlineEvidence.rendererFallback}));
    }
    else await expect(page.locator('#status')).not.toContainText('App Worker running');
  } finally {
    await context.close();
  }
});

if (candidate === 'U') {
  test('pinned Playwright offline emulation Blob Worker characterization', async ({browserName, context}) => {
    const probePage = await context.newPage();
    const runBlobWorker = () => probePage.evaluate(() => new Promise<'ok' | 'error' | 'timeout'>((resolve) => {
      const url = URL.createObjectURL(new Blob(["self.postMessage('ok')"], {type: 'text/javascript'}));
      const worker = new Worker(url);
      let settled = false;
      const finish = (result: 'ok' | 'error' | 'timeout') => {
        if (settled) return;
        settled = true;
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      worker.onmessage = () => finish('ok');
      worker.onerror = (event) => { event.preventDefault(); finish('error'); };
      setTimeout(() => finish('timeout'), 2_000);
    }));
    try {
      await probePage.goto('about:blank');
      expect(await runBlobWorker()).toBe('ok');
      await context.setOffline(true);
      expect(await runBlobWorker()).toBe(browserName === 'webkit' ? 'error' : 'ok');
    } finally {
      await context.setOffline(false);
      await probePage.close();
    }
  });
}

if (usesClassicWorker) {
  test(`Candidate ${candidate} external watchdog terminates a hung event and restarts from saved state`, async ({page, request}) => {
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#status')).toContainText('App Worker running');
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
    const host = page.locator('#app-host');
    if (candidate === 'U') {
      await expect(host).toHaveAttribute('data-worker-state', 'running');
      await expect(host).toHaveAttribute('data-worker-generation', '1');
      await expect(host).toHaveAttribute('data-worker-restart-count', '0');
    }
    await page.frameLocator('iframe').getByRole('button', {name: 'Run bounded watchdog fixture'}).click();
    await expect(page.locator('h1')).toHaveText('Decision Board');
    if (candidate === 'U') {
      await expect(host).toHaveAttribute('data-worker-last-reason', 'WORKER_WATCHDOG_TIMEOUT', {timeout: 5_000});
      await expect(host).toHaveAttribute('data-worker-generation', '2');
      await expect(host).toHaveAttribute('data-worker-restart-count', '1');
      await expect(host).toHaveAttribute('data-worker-state', 'running');
    }
    await expect(page.locator('#status')).toContainText('App Worker running', {timeout: 5_000});
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
    if (candidate === 'U') {
      await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
      await expect(page.frameLocator('iframe').getByText('Decisions: 2')).toBeVisible();
      await page.waitForTimeout(1_250);
      await expect(host).toHaveAttribute('data-worker-generation', '2');
    }
    const canary = await evidenceCounts(request);
    expect(canary.http).toBe(0);
    expect(canary.ws).toBe(0);
  });
}

if (candidate === 'U') {
  test('Candidate U exhausts its single watchdog restart budget and fail-stops', async ({page}) => {
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    const host = page.locator('#app-host');
    await expect(host).toHaveAttribute('data-worker-state', 'running');
    await page.frameLocator('iframe').getByRole('button', {name: 'Run bounded watchdog fixture'}).click();
    await expect(host).toHaveAttribute('data-worker-generation', '2', {timeout: 5_000});
    await expect(host).toHaveAttribute('data-worker-state', 'running');
    await page.frameLocator('iframe').getByRole('button', {name: 'Run bounded watchdog fixture'}).click();
    await expect(host).toHaveAttribute('data-worker-state', 'stopped', {timeout: 5_000});
    await expect(host).toHaveAttribute('data-worker-stop-code', 'WORKER_RESTART_BUDGET_EXHAUSTED');
    await expect(host).toHaveAttribute('data-worker-generation', '2');
    await expect(host).toHaveAttribute('data-worker-restart-count', '1');
    await expect(page.locator('#status')).toHaveText('Controller stopped: WORKER_RESTART_BUDGET_EXHAUSTED. Local export remains available.');
    await page.waitForTimeout(1_250);
    await expect(host).toHaveAttribute('data-worker-state', 'stopped');
    await expect(host).toHaveAttribute('data-worker-generation', '2');
  });
}

if (candidate === 'T' || candidate === 'U') {
  test(`Candidate ${candidate} private port and lexical authority boundary`, async ({page}) => {
    await page.goto('/', {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#status')).toContainText('App Worker running');
    await expect(page.frameLocator('iframe').getByText('Decisions: 0')).toBeVisible();
    if (candidate === 'U') {
      await expect(page.frameLocator('iframe').getByText('Lexical isolation: 15/15')).toBeVisible();
      await expect(page.frameLocator('iframe').getByText('Authority probes: 9/9')).toBeVisible();
      await expect(page.frameLocator('iframe').getByText('LEXICAL_AUTHORITY_LEAK')).toHaveCount(0);
      await expect(page.frameLocator('iframe').getByText('AUTHORITY_PROBE_ESCAPE')).toHaveCount(0);
      const publisherReachedDom = await page.frames().find((item) => item !== page.mainFrame() && item.url().includes('/runtime/renderer/'))?.evaluate(() => (globalThis as typeof globalThis & {__smallframePublisherReachedDom?: boolean}).__smallframePublisherReachedDom === true);
      expect(publisherReachedDom).toBe(false);
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-state', 'running');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-generation', '1');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-wasm-started', 'true');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-wasm-probe', '4169908153');
      await expect(page.locator('#app-host')).toHaveAttribute('data-worker-wasm-digest', phase0WasmDigest);
      const wasmBytes = Number(await page.locator('#app-host').getAttribute('data-worker-wasm-bytes'));
      expect(wasmBytes).toBe(phase0WasmArtifact.byteLength);
      await expect(page.locator('#app-host')).toHaveAttribute('data-verifier-started', 'true');
      await expect(page.locator('#app-host')).toHaveAttribute('data-verifier-version', '1');
      await expect(page.locator('#app-host')).toHaveAttribute('data-verifier-digest', phase1WasmDigest);
      const verifierBytes = Number(await page.locator('#app-host').getAttribute('data-verifier-bytes'));
      expect(verifierBytes).toBe(phase1WasmArtifact.byteLength);
      expect(verifierBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    await expect(page.frameLocator('iframe').getByText('Decisions: 1')).toBeVisible();
    await expect(page.locator('#status')).toContainText('renderer accepted the declarative tree');
  });
}
