import {createHash} from 'node:crypto';
import {createReadStream, existsSync, readFileSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, normalize, sep} from 'node:path';
import {WebSocketServer} from 'ws';

const root = process.cwd();
const dist = join(root, 'dist', 'controller');
const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'U';
const canary = {http: 0, ws: 0, paths: []};
const appNetwork = {count: 0, paths: []};
const serviceWorkerRequests = [];
const rendererFaultTokens = new Set();
const rendererFallback = {count: 0, paths: []};
const rendererMutation = {count: 0, paths: []};
const mutateRenderer = process.env.SMALLFRAME_T_MUTATE_RENDERER === '1' || process.env.SMALLFRAME_U_MUTATE_RENDERER === '1';
const rendererCspMatch = readFileSync(join(dist, 'sw.js'), 'utf8').match(/const RENDERER_CSP = ("(?:\\.|[^"])*");/u);
const rendererCsp = rendererCspMatch ? JSON.parse(rendererCspMatch[1]) : '';
const rendererScriptHash = rendererCsp.match(/'sha256-[^']+'/u)?.[0] ?? '';
const rendererStyleHash = rendererCsp.match(/style-src ('sha256-[^']+')/u)?.[1] ?? '';
const controllerScriptSource = candidate === 'A' ? `'self' 'wasm-unsafe-eval' blob: ${rendererScriptHash}` : "'self' 'wasm-unsafe-eval'";
const controllerStyleSource = candidate === 'A' ? `'self' ${rendererStyleHash}` : "'self'";
const controllerTrustedTypes = candidate === 'A' ? 'smallframe-controller smallframe-renderer-worker' : 'smallframe-controller';
const controllerFrameSrc = candidate === 'T' || candidate === 'U' ? 'http://app.localhost:4173/runtime/renderer/ http://app.localhost:4173/sw.js' : 'http://app.localhost:4173/runtime/renderer/';
const controllerHeaders = {
  'Content-Security-Policy': `default-src 'none'; script-src ${controllerScriptSource}; style-src ${controllerStyleSource}; img-src 'self' data:; font-src 'self'; connect-src 'self' http://api.localhost:8787 ws://api.localhost:8787; frame-src ${controllerFrameSrc}; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ${controllerTrustedTypes}`,
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), midi=()'
};
const PROVENANCE_HEADER = 'X-Smallframe-Response-Provenance';
const serviceWorkerHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src http://app.localhost:4173/runtime/renderer/ http://app.localhost:4173/index.html http://app.localhost:4173/main.js http://app.localhost:4173/personal-store.js http://app.localhost:4173/personal-runtime.js http://app.localhost:4173/fixture-module.js http://app.localhost:4173/controller.css http://app.localhost:4173/manifest.webmanifest http://app.localhost:4173/icon.svg http://app.localhost:4173/release.json; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/javascript; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};
const contentType = (path) => ({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml'}[extname(path)] ?? 'application/octet-stream');
const bodyJson = (request, limit = 4096) => new Promise((resolve, reject) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > limit) reject(new Error('body too large')); });
  request.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('invalid json')); } });
  request.on('error', reject);
});
const hasRendererFault = (request) => {
  const cookies = request.headers.cookie ?? '';
  return [...rendererFaultTokens].some((token) => cookies.split(';').some((part) => part.trim() === `smallframe-renderer-fault=${token}`));
};
const resetEvidence = () => {
  canary.http = 0;
  canary.ws = 0;
  canary.paths.length = 0;
  rendererFallback.count = 0;
  rendererFallback.paths.length = 0;
  rendererMutation.count = 0;
  rendererMutation.paths.length = 0;
  appNetwork.count = 0;
  appNetwork.paths.length = 0;
  serviceWorkerRequests.length = 0;
  rendererFaultTokens.clear();
};
const evidenceSnapshot = () => ({...canary, rendererFallback: {...rendererFallback}, rendererMutation: {...rendererMutation}, appNetwork: {...appNetwork}, serviceWorkerRequests: [...serviceWorkerRequests]});
const validControllerQuery = (url) => {
  if (!url.search) return true;
  if (url.pathname !== '/') return false;
  const allowed = new Set(['personal', 'role']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return false;
  if (url.searchParams.has('personal') && url.searchParams.get('personal') !== '1') return false;
  return !url.searchParams.has('role') || ['viewer', 'editor'].includes(url.searchParams.get('role'));
};
const staticHandler = (request, response) => {
  const url = new URL(request.url ?? '/', 'http://app.localhost:4173');
  if (url.pathname === '/__test__/evidence/reset' && request.method === 'POST') {
    resetEvidence();
    response.writeHead(204, {'Cache-Control': 'no-store'}).end();
    return;
  }
  if (url.pathname === '/__test__/renderer-fault' && request.method === 'POST') {
    void bodyJson(request).then((body) => {
      if (!body || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/u.test(body.token)) throw new Error('invalid fault token');
      rendererFaultTokens.add(body.token);
      response.writeHead(204, {'Cache-Control': 'no-store'}).end();
    }).catch(() => response.writeHead(400, {'Cache-Control': 'no-store'}).end());
    return;
  }
  if (url.pathname === '/__test__/evidence/counts' && request.method === 'GET') {
    response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(evidenceSnapshot()));
    return;
  }
  appNetwork.count += 1;
  appNetwork.paths.push(request.url ?? '');
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/sw.js/') || url.pathname.startsWith('/sw.js%') || url.pathname === '/%73w.js' || url.pathname === '/%73w%2Ejs') {
    const file = join(dist, 'sw.js');
    const exact = request.method === 'GET' && !url.search && url.pathname === '/sw.js' && existsSync(file) && statSync(file).isFile();
    const forcedFailure = request.method === 'GET' && url.pathname === '/sw.js' && url.search === '?status=500';
    const forcedRedirect = request.method === 'GET' && url.pathname === '/sw.js' && url.search === '?redirect=1';
    const status = exact ? 200 : forcedFailure ? 500 : forcedRedirect ? 302 : 404;
    serviceWorkerRequests.push({target: request.url ?? '', pathname: url.pathname, search: url.search, method: request.method ?? '', destination: request.headers['sec-fetch-dest'] ?? '', status});
    if (exact) {
      response.writeHead(status, serviceWorkerHeaders);
      createReadStream(file).pipe(response);
    } else if (forcedRedirect) response.writeHead(status, {...serviceWorkerHeaders, Location: '/sw.js'}).end('/* service worker redirect rejected by verifier */');
    else response.writeHead(status, serviceWorkerHeaders).end('/* service worker request rejected */');
    return;
  }
  if (url.pathname === '/canary') { canary.http += 1; canary.paths.push(url.pathname + url.search); response.writeHead(204, {'Cache-Control': 'no-store'}).end(); return; }
  if (url.pathname === '/connectivity' && request.method === 'GET' && !url.search) { response.writeHead(204, {'Cache-Control': 'no-store'}).end(); return; }
  if (url.pathname === '/sw-probe') { response.writeHead(404, {...controllerHeaders, [PROVENANCE_HEADER]: 'network-fallback', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}).end('network-fallback'); return; }
  const relative = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(dist, relative));
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile() || !validControllerQuery(url)) { response.writeHead(404, {'Content-Type': 'text/plain', ...controllerHeaders}).end('not found'); return; }
  if (relative.startsWith('/runtime/renderer/') && request.headers['sec-fetch-dest'] === 'iframe' && hasRendererFault(request)) {
    rendererFallback.count += 1;
    rendererFallback.paths.push(url.pathname);
    response.writeHead(503, {...controllerHeaders, [PROVENANCE_HEADER]: 'network-fault', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}).end('renderer fault injected');
    return;
  }
  response.writeHead(200, {...controllerHeaders, ...(relative.startsWith('/runtime/') ? {[PROVENANCE_HEADER]: 'network-fallback'} : {}), 'Content-Type': contentType(file), 'Cache-Control': relative.startsWith('/runtime/') ? 'no-store' : 'no-cache'});
  if (mutateRenderer && relative.startsWith('/runtime/renderer/')) {
    const body = readFileSync(file);
    body[0] = body[0] ^ 1;
    rendererMutation.count += 1;
    rendererMutation.paths.push(url.pathname);
    response.end(body);
  } else createReadStream(file).pipe(response);
};
const apiHandler = (request, response) => {
  const url = new URL(request.url ?? '/', 'http://api.localhost:8787');
  response.setHeader('Access-Control-Allow-Origin', 'http://app.localhost:4173');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, SF-Known-Epoch');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (url.pathname === '/__test__/evidence/reset' && request.method === 'POST') {
    resetEvidence();
    response.writeHead(204, {'Cache-Control': 'no-store'}).end();
    return;
  }
  if (url.pathname === '/__test__/evidence/counts' && request.method === 'GET') {
    response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(evidenceSnapshot()));
    return;
  }
  if (url.pathname === '/__test__/controller-network' && request.method === 'POST') {
    void bodyJson(request).then(async (body) => {
      if (!body || typeof body.online !== 'boolean') throw new Error('invalid controller-network state');
      await setControllerNetwork(body.online);
      response.writeHead(204, {'Cache-Control': 'no-store'}).end();
    }).catch(() => response.writeHead(400, {'Cache-Control': 'no-store'}).end());
    return;
  }
  if (url.pathname === '/healthz') { response.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}'); return; }
  response.writeHead(404, {'Content-Type': 'application/problem+json'}).end('{"type":"about:blank","title":"Not found","status":404}');
};
const controllerServer = createServer(staticHandler);
const apiServer = createServer(apiHandler);
const setControllerNetwork = (online) => new Promise((resolve, reject) => {
  if (online) {
    if (controllerServer.listening) { resolve(); return; }
    const onError = (error) => { controllerServer.off('listening', onListening); reject(error); };
    const onListening = () => { controllerServer.off('error', onError); resolve(); };
    controllerServer.once('error', onError);
    controllerServer.once('listening', onListening);
    controllerServer.listen(4173, '127.0.0.1');
    return;
  }
  if (!controllerServer.listening) { resolve(); return; }
  controllerServer.close((error) => error ? reject(error) : resolve());
  controllerServer.closeAllConnections();
});
const canaryServer = createServer((request, response) => {
  if (new URL(request.url ?? '/', 'http://localhost:8790').pathname === '/counts') { response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(canary)); return; }
  canary.http += 1; canary.paths.push(request.url ?? ''); response.writeHead(204).end();
});
const sockets = new WebSocketServer({port: 8791, host: '127.0.0.1', path: '/canary'});
sockets.on('connection', (socket) => { canary.ws += 1; socket.close(); });
controllerServer.listen(4173, '127.0.0.1');
apiServer.listen(8787, '127.0.0.1');
canaryServer.listen(8790, '127.0.0.1');
for (const server of [controllerServer, apiServer, canaryServer]) server.on('error', (error) => { console.error('server error', error.message); process.exitCode = 1; });
process.on('SIGTERM', () => {
  sockets.close();
  if (controllerServer.listening) controllerServer.close();
  if (apiServer.listening) apiServer.close();
  if (canaryServer.listening) canaryServer.close();
});
console.log(JSON.stringify({controller: 'http://app.localhost:4173', api: 'http://api.localhost:8787', canary: 'http://localhost:8790', websocketCanary: 'ws://localhost:8791/canary'}));
