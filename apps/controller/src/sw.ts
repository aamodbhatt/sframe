const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const RENDERER_DIGEST = '__RENDERER_DIGEST__';
const RENDERER_PATH = `/runtime/renderer/${RENDERER_DIGEST}.html`;
const CACHE = `smallframe-renderer-${RENDERER_DIGEST}`;
const MAX_RENDERER_BYTES = 2 * 1024 * 1024;
const RENDERER_CSP = "default-src 'none'; script-src 'sha256-__RENDERER_BOOTSTRAP_HASH__'__RENDERER_WASM_EVAL_SOURCE__ blob:; style-src 'sha256-__RENDERER_CSS_HASH__'; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src blob:; child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors http://app.localhost:4173; sandbox allow-scripts; require-trusted-types-for 'script'; trusted-types smallframe-renderer-worker";
const PROVENANCE_HEADER = 'X-Smallframe-Response-Provenance';

const rendererHeaders = (): Headers => new Headers({
  'Content-Security-Policy': RENDERER_CSP,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), midi=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  [PROVENANCE_HEADER]: 'service-worker-cache',
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, max-age=31536000, immutable'
});

const sha256Hex = async (body: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch(new URL(RENDERER_PATH, sw.location.origin).href, {redirect: 'error', cache: 'no-store'});
    if (response.status !== 200 || response.headers.get('content-type')?.toLowerCase() !== 'text/html; charset=utf-8') throw new Error('RENDERER_RESPONSE_INVALID');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RENDERER_BYTES || await sha256Hex(body) !== RENDERER_DIGEST) throw new Error('RENDERER_DIGEST_MISMATCH');
    const cache = await caches.open(CACHE);
    await cache.put(RENDERER_PATH, new Response(body, {status: 200, headers: rendererHeaders()}));
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('smallframe-renderer-') && key !== CACHE).map((key) => caches.delete(key)));
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.pathname === '/sw-probe' && !url.search && !event.request.headers.has('range')) {
    event.respondWith(new Response(`smallframe-service-worker:${RENDERER_DIGEST}`, {status: 200, headers: {'Content-Type': 'text/plain; charset=utf-8', [PROVENANCE_HEADER]: 'service-worker-probe', 'Cache-Control': 'no-store'}}));
    return;
  }
  if (event.request.method !== 'GET' || url.pathname !== RENDERER_PATH || url.search || event.request.headers.has('range')) return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(RENDERER_PATH)).then((response) => response ?? new Response('renderer unavailable', {status: 503})));
});

sw.addEventListener('message', (event) => {
  const responsePort = event.ports[0];
  if (event.data?.type === 'sf.claim') {
    event.waitUntil(sw.clients.claim());
    return;
  }
  if (event.data?.type === 'sf.attest' && responsePort) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const response = await cache.match(RENDERER_PATH);
      if (!response) {
        responsePort.postMessage({type: 'sf.attest.result', protocol: 1, digest: RENDERER_DIGEST, cachePresent: false});
        return;
      }
      const body = await response.clone().arrayBuffer();
      responsePort.postMessage({
        type: 'sf.attest.result',
        protocol: 1,
        digest: RENDERER_DIGEST,
        cachePresent: true,
        responseDigest: await sha256Hex(body),
        contentSecurityPolicy: response.headers.get('content-security-policy'),
        provenance: response.headers.get(PROVENANCE_HEADER)
      });
    })());
  }
});

export {};
