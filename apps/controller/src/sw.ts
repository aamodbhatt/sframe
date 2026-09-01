const sw = globalThis as unknown as ServiceWorkerGlobalScope;
const RENDERER_DIGEST = '__RENDERER_DIGEST__';
const RENDERER_PATH = `/runtime/renderer/${RENDERER_DIGEST}.html`;
const MAX_RENDERER_BYTES = 2 * 1024 * 1024;
const RENDERER_CSP = "default-src 'none'; script-src 'sha256-__RENDERER_BOOTSTRAP_HASH__'__RENDERER_WASM_EVAL_SOURCE__ blob:; style-src 'sha256-__RENDERER_CSS_HASH__'; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src blob:; child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors http://app.localhost:4173; sandbox allow-scripts; require-trusted-types-for 'script'; trusted-types smallframe-renderer-worker";
const PROVENANCE_HEADER = 'X-Smallframe-Response-Provenance';
const RELEASE_ROOT_KEY_ID = 'sha256:h-5zg31LoCDgdHkLQnZ6NPQ16O9g8tTJ2qdzt8QlGkA';
const RELEASE_ROOT_PUBLIC_KEY = 'IBLLkMpg6OXY2vZuInLSIz4EhtVX6MZhQe2JIBd9frc';
const RELEASE_PAYLOAD_TYPE = 'application/vnd.smallframe.controller-release.v1+json';

type ReleaseAsset = {bytes: number; sha256: string};
type ReleaseRecord = {
  schemaVersion: number;
  gitCommit: string;
  createdAt: number;
  controllerShellDigest: string;
  controllerAssetSetDigest: string;
  serviceWorkerDigest: string;
  rendererDigest: string;
  verifierDigest: string;
  protocolMin: number;
  protocolMax: number;
  buildId: string;
};
type ReleaseEnvelope = {
  schemaVersion: number;
  payloadType: string;
  payload: string;
  signatures: Array<{keyId: string; sig: string}>;
  record: ReleaseRecord;
  assetSet: Record<string, ReleaseAsset>;
};

let installedBuildId = '';
let installedRendererDigest = RENDERER_DIGEST;

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

const base64UrlToBytes = (base64url: string): Uint8Array => {
  const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b !== undefined) binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const sha256Base64Url = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToBase64Url(new Uint8Array(digest));
};

const sha256Hex = async (body: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const jcsStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcsStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcsStringify(record[k])}`).join(',')}}`;
};

const verifyReleaseSignature = async (payloadType: string, payloadBytes: Uint8Array, signatureB64Url: string): Promise<boolean> => {
  const rootKeyBytes = base64UrlToBytes(RELEASE_ROOT_PUBLIC_KEY);
  const sigBytes = base64UrlToBytes(signatureB64Url);
  const prefix = new TextEncoder().encode(`DSSEv1 ${payloadType.length} ${payloadType} ${payloadBytes.byteLength} `);
  const pae = new Uint8Array(prefix.byteLength + payloadBytes.byteLength);
  pae.set(prefix);
  pae.set(payloadBytes, prefix.byteLength);
  const cryptoKey = await crypto.subtle.importKey('raw', rootKeyBytes, {name: 'Ed25519'}, false, ['verify']);
  return await crypto.subtle.verify({name: 'Ed25519'}, cryptoKey, sigBytes, pae);
};

const recomputeBuildId = async (record: ReleaseRecord): Promise<string> => {
  const recordWithout = {
    schemaVersion: record.schemaVersion,
    gitCommit: record.gitCommit,
    createdAt: record.createdAt,
    controllerShellDigest: record.controllerShellDigest,
    controllerAssetSetDigest: record.controllerAssetSetDigest,
    serviceWorkerDigest: record.serviceWorkerDigest,
    rendererDigest: record.rendererDigest,
    verifierDigest: record.verifierDigest,
    protocolMin: record.protocolMin,
    protocolMax: record.protocolMax
  };
  const canonicalWithout = new TextEncoder().encode(jcsStringify(recordWithout));
  const prefix = new TextEncoder().encode('smallframe/controller-release/v1\0');
  const combined = new Uint8Array(prefix.byteLength + canonicalWithout.byteLength);
  combined.set(prefix);
  combined.set(canonicalWithout, prefix.byteLength);
  return await sha256Base64Url(combined);
};

const verifyReleaseRecord = async (envelope: ReleaseEnvelope, payloadBytes: Uint8Array): Promise<ReleaseRecord> => {
  const signatureEntry = envelope.signatures?.[0];
  if (!signatureEntry || envelope.signatures.length !== 1) throw new Error('RELEASE_SIGNATURES_INVALID');
  if (signatureEntry.keyId !== RELEASE_ROOT_KEY_ID) throw new Error('RELEASE_KEY_ID_MISMATCH');
  const validSig = await verifyReleaseSignature(envelope.payloadType, payloadBytes, signatureEntry.sig);
  if (!validSig) throw new Error('RELEASE_SIGNATURE_INVALID');
  const record = envelope.record;
  if (record.schemaVersion !== 1) throw new Error('RELEASE_SCHEMA_VERSION_INVALID');
  if (record.protocolMin > 1 || record.protocolMax < 1) throw new Error('RELEASE_PROTOCOL_INCOMPATIBLE');
  if (!/^[0-9a-f]{40}$/u.test(record.gitCommit)) throw new Error('RELEASE_GIT_COMMIT_INVALID');
  const computedBuildId = await recomputeBuildId(record);
  if (computedBuildId !== record.buildId) throw new Error('RELEASE_BUILD_ID_MISMATCH');
  const assetSetCanonical = new TextEncoder().encode(jcsStringify(envelope.assetSet));
  const computedAssetSetDigest = await sha256Base64Url(assetSetCanonical);
  if (computedAssetSetDigest !== record.controllerAssetSetDigest) throw new Error('RELEASE_ASSET_SET_DIGEST_MISMATCH');
  return record;
};

const verifyAndCacheAssets = async (record: ReleaseRecord, assetSet: Record<string, ReleaseAsset>, rawReleaseJson: string): Promise<void> => {
  const shellCacheName = `smallframe-shell-${record.buildId}`;
  const rendererCacheName = `smallframe-renderer-${record.rendererDigest}`;
  const shellCache = await caches.open(shellCacheName);
  const rendererCache = await caches.open(rendererCacheName);
  await shellCache.put('/release.json', new Response(rawReleaseJson, {status: 200, headers: {'Content-Type': 'application/json; charset=utf-8', [PROVENANCE_HEADER]: 'service-worker-cache'}}));

  for (const [path, entry] of Object.entries(assetSet)) {
    const fetchUrl = new URL(path === '/' ? '/index.html' : path, sw.location.origin).href;
    const response = await fetch(fetchUrl, {redirect: 'error', cache: 'no-store'});
    if (response.status !== 200) throw new Error(`ASSET_RESPONSE_INVALID_${path}`);
    const body = await response.arrayBuffer();
    if (body.byteLength !== entry.bytes) throw new Error(`ASSET_SIZE_MISMATCH_${path}`);
    const computedDigest = await sha256Base64Url(body);
    if (computedDigest !== entry.sha256) throw new Error(`ASSET_DIGEST_MISMATCH_${path}`);
    if (path.startsWith('/runtime/renderer/')) {
      if (body.byteLength > MAX_RENDERER_BYTES) throw new Error('RENDERER_TOO_LARGE');
      await rendererCache.put(path, new Response(body, {status: 200, headers: rendererHeaders()}));
    } else {
      await shellCache.put(path, new Response(body, {status: 200, headers: {'Content-Type': path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript; charset=utf-8', [PROVENANCE_HEADER]: 'service-worker-cache'}}));
      if (path === '/index.html') {
        await shellCache.put('/', new Response(body, {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8', [PROVENANCE_HEADER]: 'service-worker-cache'}}));
      }
    }
  }
};

const installRelease = async (): Promise<void> => {
  const releaseUrl = new URL('/release.json', sw.location.origin).href;
  const releaseResponse = await fetch(releaseUrl, {redirect: 'error', cache: 'no-store'});
  if (releaseResponse.status !== 200) throw new Error('RELEASE_JSON_NOT_FOUND');
  const rawReleaseJson = await releaseResponse.text();
  const envelope = JSON.parse(rawReleaseJson) as ReleaseEnvelope;
  const payloadBytes = base64UrlToBytes(envelope.payload);
  const record = await verifyReleaseRecord(envelope, payloadBytes);
  installedBuildId = record.buildId;
  installedRendererDigest = record.rendererDigest;
  await verifyAndCacheAssets(record, envelope.assetSet, rawReleaseJson);
  if (!sw.registration.active) await sw.skipWaiting();
};

sw.addEventListener('install', (event) => {
  event.waitUntil(installRelease());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const activeShellCache = installedBuildId ? `smallframe-shell-${installedBuildId}` : '';
    const activeRendererCache = `smallframe-renderer-${installedRendererDigest || RENDERER_DIGEST}`;
    await Promise.all(keys.filter((key) => {
      const isShell = key.startsWith('smallframe-shell-');
      const isRenderer = key.startsWith('smallframe-renderer-');
      return (isShell && activeShellCache && key !== activeShellCache) || (isRenderer && key !== activeRendererCache);
    }).map((key) => caches.delete(key)));
    await sw.clients.claim();
  })());
});

const handleRendererFetch = async (pathname: string): Promise<Response> => {
  const keys = await caches.keys();
  const rendererCaches = keys.filter((key) => key.startsWith('smallframe-renderer-'));
  for (const cacheName of rendererCaches) {
    const cache = await caches.open(cacheName);
    const match = await cache.match(pathname);
    if (match) return match;
  }
  return new Response('renderer unavailable', {status: 503});
};

const handleShellFetch = async (pathname: string, request: Request): Promise<Response> => {
  const keys = await caches.keys();
  const shellCaches = keys.filter((key) => key.startsWith('smallframe-shell-')).reverse();
  for (const cacheName of shellCaches) {
    const cache = await caches.open(cacheName);
    const match = await cache.match(pathname);
    if (match) return match;
  }
  return fetch(request).catch(() => new Response('offline shell unavailable', {status: 503}));
};

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== sw.location.origin || event.request.headers.has('range') || url.pathname === '/sw.js' || url.pathname.startsWith('/sw.js') || url.pathname.includes('73w')) return;
  if (url.pathname === '/sw-probe' && !url.search) {
    event.respondWith(new Response(`smallframe-service-worker:${RENDERER_DIGEST}`, {status: 200, headers: {'Content-Type': 'text/plain; charset=utf-8', [PROVENANCE_HEADER]: 'service-worker-probe', 'Cache-Control': 'no-store'}}));
    return;
  }
  if (url.pathname.startsWith('/runtime/renderer/')) {
    event.respondWith(handleRendererFetch(url.pathname));
    return;
  }
  const isControllerNavigation = event.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  const pathname = isControllerNavigation ? '/' : url.pathname;
  event.respondWith(handleShellFetch(pathname, event.request));
});

sw.addEventListener('message', (event) => {
  const responsePort = event.ports[0];
  const type = event.data?.type;
  if (type === 'sf.claim') {
    event.waitUntil(sw.clients.claim());
  } else if (type === 'sf.release.skipWaiting') {
    event.waitUntil(sw.skipWaiting());
  } else if (type === 'sf.release.info' && responsePort) {
    responsePort.postMessage({type: 'sf.release.info.result', buildId: installedBuildId, rendererDigest: installedRendererDigest});
  } else if (type === 'sf.attest' && responsePort) {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      const rendererCaches = keys.filter((key) => key.startsWith('smallframe-renderer-'));
      let response: Response | undefined;
      for (const cacheName of rendererCaches) {
        const cache = await caches.open(cacheName);
        response = await cache.match(RENDERER_PATH);
        if (response) break;
      }
      if (!response) {
        responsePort.postMessage({type: 'sf.attest.result', protocol: 1, digest: RENDERER_DIGEST, cachePresent: false});
        return;
      }
      const body = await response.clone().arrayBuffer();
      responsePort.postMessage({
        type: 'sf.attest.result',
        protocol: 1,
        digest: RENDERER_DIGEST,
        buildId: installedBuildId,
        cachePresent: true,
        responseDigest: await sha256Hex(body),
        contentSecurityPolicy: response.headers.get('content-security-policy'),
        provenance: response.headers.get(PROVENANCE_HEADER)
      });
    })());
  }
});

export {};
