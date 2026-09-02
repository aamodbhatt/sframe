const RENDERER_DIGEST = '__RENDERER_DIGEST__';
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const ARCHITECTURE_CANDIDATE: string = '__ARCHITECTURE_CANDIDATE__';
const CHANNEL_TEST_FIXTURE: string = '__CHANNEL_TEST_FIXTURE__';
const PHASE0_WASM_BYTES = Number('__PHASE0_WASM_BYTES__');
const PHASE1_WASM_BYTES = Number('__PHASE1_WASM_BYTES__');
const PHASE2_PACKAGE_BASE64 = '__PHASE2_PACKAGE_BASE64__';
const PHASE2_DEFAULT = Boolean(Number('__PHASE2_DEFAULT_FLAG__'));
const PHASE2_EXPECTED_DIGEST = '__PHASE2_EXPECTED_DIGEST__';
const PHASE2_EXPECTED_KEY_ID = '__PHASE2_EXPECTED_KEY_ID__';
const initialHash = window.location.hash;
const fromB64Url = (str: string): Uint8Array => {
  const base64 = str.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
let parsedInvite: any = undefined;
if (initialHash.includes('v=1&d=') || initialHash.includes('d=')) {
  try {
    const rawFragment = initialHash.startsWith('#') ? initialHash.slice(1) : initialHash;
    const params = new URLSearchParams(rawFragment);
    const d = params.get('d');
    const s = params.get('s');
    const k = params.get('k');
    const c = params.get('c');
    const w = params.get('w');
    if (d && s && k && c) {
      const descriptorJson = new TextDecoder().decode(fromB64Url(d));
      const descriptor = JSON.parse(descriptorJson);
      parsedInvite = {
        version: 1,
        descriptor,
        descriptorSignature: fromB64Url(s),
        roomKey: fromB64Url(k),
        capability: fromB64Url(c),
        writerPrivateSeed: w ? fromB64Url(w) : undefined
      };
    }
  } catch (_) {}
}

const SHARED_MODE = Boolean(parsedInvite || new URLSearchParams(location.search).get('room') === '1');
const PERSONAL_MODE = Boolean(!SHARED_MODE && (PHASE2_DEFAULT || new URLSearchParams(location.search).get('personal') === '1'));
const USES_CLASSIC_WORKER = ARCHITECTURE_CANDIDATE === 'S' || ARCHITECTURE_CANDIDATE === 'T' || ARCHITECTURE_CANDIDATE === 'U' || PERSONAL_MODE || SHARED_MODE;
const IS_CANDIDATE_U = ARCHITECTURE_CANDIDATE === 'U' || PERSONAL_MODE || SHARED_MODE;
const PERSONAL_ROLE: 'viewer' | 'editor' = (parsedInvite?.descriptor?.role ?? (new URLSearchParams(location.search).get('role') === 'viewer' ? 'viewer' : 'editor')) as 'viewer' | 'editor';
let sharedExecutionRole: 'viewer' | 'editor' = 'viewer';
const executionRole = (): 'viewer' | 'editor' => SHARED_MODE ? sharedExecutionRole : PERSONAL_MODE ? PERSONAL_ROLE : 'editor';
const executionIsReadOnly = (): boolean => executionRole() === 'viewer';
const RENDERER_PATH = `/runtime/renderer/${RENDERER_DIGEST}.html`;
const MAX_RENDERER_BYTES = 4 * 1024 * 1024;
const REQUIRED_RENDERER_CSP = "default-src 'none'; script-src 'sha256-__RENDERER_BOOTSTRAP_HASH__'__RENDERER_WASM_EVAL_SOURCE__ blob:; style-src 'sha256-__RENDERER_CSS_HASH__'; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src blob:; child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors http://app.localhost:4173; sandbox allow-scripts; require-trusted-types-for 'script'; trusted-types smallframe-renderer-worker";
const MAX_MESSAGE_BYTES = 256 * 1024;
let frame: HTMLIFrameElement | undefined;
let port: MessagePort | undefined;
let portSequence = 0;
let expectedPortSequence = 1;
let activeSessionId = '';
let controllerChannelTerminal = false;
let channelFixtureInjected = false;
let rendererInitTimer = 0;
let workerLifecycleState: 'idle' | 'booting' | 'running' | 'restarting' | 'stopped' = 'idle';
let workerLifecycleGeneration = 0;
let workerLifecycleRestartCount = 0;
let acceptedAppReadyGeneration = 0;
let localState: Record<string, unknown> = {decisions: {}};
let localRevision = 0;
let personalArchive = new Uint8Array();
let stateMutationInFlight = false;
type StateValidation = {resolve: (result: {valid: boolean; error: string}) => void; timer: number};
const stateValidations = new Map<string, StateValidation>();
type PersonalPackageMetadata = {packageDigest: string; artifactDigest: string; publisherKeyId: string; publisherPublicKey: string; publisherDisplayName: string; appName: string; appVersion: string; description: string; capabilities: string[]; publicTemplate: Record<string, unknown>; maxPlaintextBytes: number; declaredMode: 'personal' | 'shared'};
type PersonalSession = {handleVerified: (metadata: PersonalPackageMetadata) => Promise<void>; stateChanged: (state: Record<string, unknown>, revision: number) => Promise<void>; setBuildId?: (buildId: string) => void; showUpdateBanner?: (waitingWorker: ServiceWorker) => void};
let personalSession: PersonalSession | undefined;

const text = (value: string): Text => document.createTextNode(value);
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${id}`);
  return element as T;
};
const byteLength = (value: unknown): number => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new Error('CHANNEL_MESSAGE_NOT_JSON');
  return new TextEncoder().encode(encoded).byteLength;
};
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const exactKeys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> => {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length) return false;
  const sorted = [...keys as string[]].sort();
  const required = [...expected].sort();
  return sorted.every((key, index) => key === required[index]);
};
const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((child) => isJsonValue(child, depth + 1));
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
  const entries = Object.entries(value);
  return entries.length <= 10_000 && entries.every(([key, child]) => key.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(key) && isJsonValue(child, depth + 1));
};
const safeMessageBytes = (value: unknown): number => {
  try { return byteLength(value); } catch (_) { return Number.POSITIVE_INFINITY; }
};
let approvedSrcdoc = '';
const controllerPolicy = (() => {
  const types = (globalThis as typeof globalThis & {trustedTypes?: {createPolicy: (name: string, rules: {createScriptURL: (url: string) => string; createHTML: (html: string) => string}) => {createScriptURL: (url: string) => unknown; createHTML: (html: string) => unknown}}}).trustedTypes;
  if (!types) return undefined;
  return types.createPolicy('smallframe-controller', {
    createScriptURL: (url) => (url === '/sw.js' || url === '/state-worker.js') ? url : (() => { throw new Error('SCRIPT_URL_NOT_ALLOWED'); })(),
    createHTML: (html) => html !== '' && html === approvedSrcdoc ? html : (() => { throw new Error('SRCDOC_NOT_VERIFIED'); })()
  });
})();
const scriptUrl = (value: string): string => controllerPolicy ? controllerPolicy.createScriptURL(value) as string : value;
Object.defineProperty(globalThis, '__smallframeScriptUrl', {value: scriptUrl, configurable: false, enumerable: false, writable: false});
const verifiedSrcdoc = (value: string): string => {
  approvedSrcdoc = value;
  try { return controllerPolicy ? controllerPolicy.createHTML(value) as string : value; } finally { approvedSrcdoc = ''; }
};
const randomBase64Url = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const randomHex = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const post = (type: string, body: Record<string, unknown> = {}): void => {
  if (!port || controllerChannelTerminal || !activeSessionId) throw new Error('CHANNEL_CLOSED');
  if (Reflect.ownKeys(body).some((key) => typeof key !== 'string' || ['channel', 'protocol', 'session', 'sequence', 'type'].includes(key))) throw new Error('CHANNEL_INTERNAL_SCHEMA');
  const nextSequence = portSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error('CHANNEL_SEQUENCE_EXHAUSTED');
  const message = {channel: 'smallframe-controller', protocol: 1, session: activeSessionId, sequence: nextSequence, type, ...body};
  if (byteLength(message) > MAX_MESSAGE_BYTES) throw new Error('CHANNEL_MESSAGE_TOO_LARGE');
  port.postMessage(message);
  portSequence = nextSequence;
};
const bounded = async <T>(promise: Promise<T>, milliseconds: number, errorCode: string): Promise<T> => await Promise.race([promise, new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(errorCode)), milliseconds))]);

const sha256Hex = async (body: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const readVerifiedRenderer = async (): Promise<string> => {
  const response = await caches.match(RENDERER_PATH);
  if (!response || response.status !== 200 || response.headers.get('content-type')?.toLowerCase() !== 'text/html; charset=utf-8') throw new Error('RENDERER_CACHE_ENTRY_INVALID');
  if (response.headers.get('content-security-policy') !== REQUIRED_RENDERER_CSP) throw new Error('RENDERER_POLICY_MISMATCH');
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RENDERER_BYTES) throw new Error('RENDERER_TOO_LARGE');
  let html: string;
  try { html = new TextDecoder('utf-8', {fatal: true}).decode(body); } catch (_) { throw new Error('RENDERER_UTF8_INVALID'); }
  if (html.startsWith('\ufeff')) throw new Error('RENDERER_UTF8_BOM');
  const roundTrip = new TextEncoder().encode(html);
  if (roundTrip.byteLength !== body.byteLength || await sha256Hex(roundTrip.buffer) !== RENDERER_DIGEST) throw new Error('RENDERER_BYTE_IDENTITY_MISMATCH');
  return html;
};

const phase2InitFields = (): {fields: Record<string, unknown>; packageBytes?: Uint8Array<ArrayBuffer>} => {
  if (!PERSONAL_MODE && !SHARED_MODE) return {fields: {}};
  const packageBytes = personalArchive.slice();
  const expectedPackageDigest = parsedInvite?.descriptor?.packageDigest ?? PHASE2_EXPECTED_DIGEST;
  const expectedPublisherKeyId = parsedInvite?.descriptor?.publisherKeyId ?? PHASE2_EXPECTED_KEY_ID;
  return {fields: {packageBytes, expectedPackageDigest, expectedPublisherKeyId}, packageBytes};
};

const postRendererInit = (target: Window | null, init: Record<string, unknown>, channelPort: MessagePort, packageBytes?: Uint8Array<ArrayBuffer>): void => {
  if (!target) throw new Error('RENDERER_WINDOW_MISSING');
  const transfers: Transferable[] = [channelPort];
  if (packageBytes) transfers.push(packageBytes.buffer);
  target.postMessage(init, '*', transfers);
};

const setupServiceWorker = async (): Promise<string | undefined> => {
  if (!('serviceWorker' in navigator)) throw new Error('SERVICE_WORKER_UNAVAILABLE');
  const existing = await navigator.serviceWorker.getRegistration('/');
  const registration = existing ?? await navigator.serviceWorker.register(scriptUrl('/sw.js'), {scope: '/', type: 'module'});
  if (!registration.active) await bounded(navigator.serviceWorker.ready, 5000, 'SERVICE_WORKER_READY_TIMEOUT');
  if (!navigator.serviceWorker.controller) {
    registration.active?.postMessage({type: 'sf.claim'});
    const controlled = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        navigator.serviceWorker.removeEventListener('controllerchange', onChange);
        window.clearTimeout(timer);
        resolve(value);
      };
      const onChange = (): void => finish(Boolean(navigator.serviceWorker.controller));
      const timer = window.setTimeout(() => finish(Boolean(navigator.serviceWorker.controller)), 3000);
      navigator.serviceWorker.addEventListener('controllerchange', onChange);
      if (navigator.serviceWorker.controller) finish(true);
    });
    if (!controlled) {
      const reloadKey = 'smallframe-sw-control-reload';
      if (sessionStorage.getItem(reloadKey) === '1') throw new Error('SERVICE_WORKER_CONTROL_UNAVAILABLE');
      sessionStorage.setItem(reloadKey, '1');
      location.reload();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 5000));
      throw new Error('SERVICE_WORKER_RELOAD_TIMEOUT');
    }
  }
  sessionStorage.removeItem('smallframe-sw-control-reload');
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error('SERVICE_WORKER_NOT_CONTROLLING');
  const channel = new MessageChannel();
  const result = new Promise<{digest: string; csp: string; buildId?: string | undefined}>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('SERVICE_WORKER_ATTEST_TIMEOUT')), 2000);
    channel.port1.onmessage = (event: MessageEvent) => {
      window.clearTimeout(timeout);
      if (event.data?.type !== 'sf.attest.result' || event.data.digest !== RENDERER_DIGEST || event.data.cachePresent !== true || event.data.responseDigest !== RENDERER_DIGEST || event.data.provenance !== 'service-worker-cache' || event.data.contentSecurityPolicy !== REQUIRED_RENDERER_CSP) reject(new Error('SERVICE_WORKER_ATTEST_MISMATCH'));
      else resolve({digest: event.data.digest as string, csp: event.data.contentSecurityPolicy as string, buildId: typeof event.data.buildId === 'string' ? event.data.buildId : undefined});
    };
  });
  controller.postMessage({type: 'sf.attest'}, [channel.port2]);
  const attest = await result;
  if (attest.buildId && personalSession?.setBuildId) personalSession.setBuildId(attest.buildId);
  byId<HTMLElement>('build').textContent = attest.buildId ? `Verified renderer ${RENDERER_DIGEST.slice(0, 16)}… · Build ${attest.buildId.slice(0, 16)}…` : `Verified renderer ${RENDERER_DIGEST.slice(0, 16)}…`;
  setupUpdateListener(registration);
  return ARCHITECTURE_CANDIDATE === 'A' ? await readVerifiedRenderer() : undefined;
};

const setupUpdateListener = (registration: ServiceWorkerRegistration): void => {
  const checkWaiting = (): void => {
    const waiting = registration.waiting;
    if (!waiting) return;
    if (personalSession?.showUpdateBanner) personalSession.showUpdateBanner(waiting);
  };
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        checkWaiting();
      }
    });
  });
  if (registration.waiting) checkWaiting();
};

const renderControllerError = (error: unknown): void => {
  byId<HTMLElement>('trust-panel').hidden = true;
  byId<HTMLElement>('runtime-panel').hidden = false;
  const panel = byId<HTMLElement>('status');
  panel.replaceChildren(text(`Controller stopped: ${error instanceof Error ? error.message : 'unknown error'}. Local export remains available.`));
  panel.dataset.state = 'error';
};

const terminateControllerChannel = (reason: string, destroyFrame = IS_CANDIDATE_U): void => {
  if (controllerChannelTerminal) return;
  controllerChannelTerminal = true;
  window.clearTimeout(rendererInitTimer);
  port?.close();
  port = undefined;
  if (destroyFrame) frame?.remove();
  activeSessionId = '';
  renderControllerError(new Error(reason));
};

const injectControllerChannelFixture = (): void => {
  if (!IS_CANDIDATE_U || channelFixtureInjected || !port || !activeSessionId || !CHANNEL_TEST_FIXTURE.startsWith('controller-')) return;
  channelFixtureInjected = true;
  const sequence = portSequence + 1;
  const base = {channel: 'smallframe-controller', protocol: 1, session: activeSessionId, sequence};
  if (CHANNEL_TEST_FIXTURE === 'controller-replay') {
    const replay = {...base, type: 'sf.controller.snapshot', state: localState, role: 'editor', online: true, revision: 0};
    port.postMessage(replay);
    port.postMessage(replay);
  }
  else if (CHANNEL_TEST_FIXTURE === 'controller-wrong-session') port.postMessage({...base, session: randomBase64Url(16), type: 'sf.controller.snapshot', state: localState, role: 'editor', online: true, revision: 0});
  else if (CHANNEL_TEST_FIXTURE === 'controller-extra-key') port.postMessage({...base, type: 'sf.controller.snapshot', state: localState, role: 'editor', online: true, revision: 0, unexpected: true});
  else if (CHANNEL_TEST_FIXTURE === 'controller-unknown-type') port.postMessage({...base, type: 'sf.controller.unknown'});
  else if (CHANNEL_TEST_FIXTURE === 'controller-oversized') port.postMessage({...base, type: 'sf.controller.snapshot', state: {oversized: 'x'.repeat(MAX_MESSAGE_BYTES)}, role: 'editor', online: true, revision: 0});
  else if (CHANNEL_TEST_FIXTURE === 'controller-transfer') {
    const transferred = new MessageChannel();
    port.postMessage({...base, type: 'sf.controller.snapshot', state: localState, role: 'editor', online: true, revision: 0}, [transferred.port2]);
    window.setTimeout(() => transferred.port1.close(), 1000);
  }
};

const startFrame = async (rendererHtml?: string): Promise<void> => {
  window.clearTimeout(rendererInitTimer);
  const nonce = ARCHITECTURE_CANDIDATE === 'A' ? '' : randomBase64Url(16);
  frame = document.createElement('iframe');
  frame.title = 'Smallframe app renderer';
  if (ARCHITECTURE_CANDIDATE !== 'R' && !USES_CLASSIC_WORKER) frame.sandbox.add('allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; payment 'none'");
  frame.dataset.rendererPath = RENDERER_PATH;
  if (!frame) throw new Error('RENDERER_FRAME_MISSING');
  const currentFrame = frame;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (event: MessageEvent): void => {
      const challenge = ARCHITECTURE_CANDIDATE === 'A' ? event.data?.challenge : event.data?.nonce;
      const readyKeys = ARCHITECTURE_CANDIDATE === 'A' ? ['type', 'protocol', 'challenge'] : ['type', 'protocol', 'nonce'];
      if (event.source !== currentFrame.contentWindow || event.origin !== 'null' || event.data?.type !== 'sf.renderer.ready' || event.data?.protocol !== 1 || (IS_CANDIDATE_U && (!exactKeys(event.data, readyKeys) || event.ports.length !== 0)) || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(challenge) || (ARCHITECTURE_CANDIDATE !== 'A' && challenge !== nonce)) return;
      const channel = new MessageChannel();
      port = channel.port1;
      portSequence = 0;
      expectedPortSequence = 1;
      controllerChannelTerminal = false;
      channelFixtureInjected = false;
      workerLifecycleState = 'idle';
      workerLifecycleGeneration = 0;
      workerLifecycleRestartCount = 0;
      acceptedAppReadyGeneration = 0;
      port.onmessage = onPortMessage;
      port.onmessageerror = () => terminateControllerChannel('CHANNEL_MESSAGE_DESERIALIZATION_FAILED', true);
      port.start();
      byId<HTMLElement>('app-host').dataset.rendererOrigin = event.origin;
      const sessionId = randomBase64Url(16);
      activeSessionId = sessionId;
      const appModule = (window as Window & {SMALLFRAME_APP_MODULE?: string}).SMALLFRAME_APP_MODULE ?? '';
      const phase2 = phase2InitFields();
      const init = {type: 'sf.renderer.init', protocol: 1, ...(ARCHITECTURE_CANDIDATE === 'A' ? {challenge} : {nonce: challenge}), sessionId, ...(USES_CLASSIC_WORKER ? {} : {appModule}), state: localState, role: executionRole(), ...phase2.fields, ...(IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'init-schema-extra' ? {unexpected: true} : {}), ...(IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'init-oversized' ? {testPadding: 'x'.repeat(MAX_MESSAGE_BYTES)} : {})};
      if (safeMessageBytes(init) > MAX_MESSAGE_BYTES) { channel.port1.close(); finish(new Error('INIT_MESSAGE_TOO_LARGE')); return; }
      postRendererInit(currentFrame.contentWindow, init, channel.port2, phase2.packageBytes);
      rendererInitTimer = window.setTimeout(() => terminateControllerChannel('RENDERER_INIT_TIMEOUT', true), 2500);
      if (IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'window-init-replay') {
        const replayChannel = new MessageChannel();
        replayChannel.port1.onmessage = () => { byId<HTMLElement>('app-host').dataset.replayedInitAccepted = 'true'; };
        replayChannel.port1.start();
        const replayInit = {...init, sessionId: randomBase64Url(16), state: {decisions: {replayed: {title: 'must remain unreachable'}}}};
        currentFrame.contentWindow?.postMessage(replayInit, '*', [replayChannel.port2]);
        window.setTimeout(() => replayChannel.port1.close(), 2000);
      }
      finish();
    };
    const timer = window.setTimeout(() => finish(new Error('RENDERER_HANDSHAKE_TIMEOUT')), 5000);
    window.addEventListener('message', onMessage);
    byId('app-host').replaceChildren(currentFrame);
    if (ARCHITECTURE_CANDIDATE === 'A') {
      if (!rendererHtml) { finish(new Error('RENDERER_SRCDOC_MISSING')); return; }
      currentFrame.srcdoc = verifiedSrcdoc(rendererHtml);
    } else {
      currentFrame.src = `${RENDERER_PATH}#${nonce}`;
    }
  });
};

type RendererMessage = {channel?: unknown; protocol?: unknown; session?: unknown; sequence?: unknown; type?: unknown; tree?: unknown; error?: unknown; requestId?: unknown; operations?: unknown; validationId?: unknown; valid?: unknown; workerKind?: unknown; blobCount?: unknown; workerSelfOrigin?: unknown; workerLocationOrigin?: unknown; workerLocationHref?: unknown; wasmStarted?: unknown; wasmBytes?: unknown; wasmProbe?: unknown; wasmDigest?: unknown; verifierStarted?: unknown; verifierBytes?: unknown; verifierVersion?: unknown; verifierDigest?: unknown; state?: unknown; generation?: unknown; restartCount?: unknown; lastReason?: unknown; stopCode?: unknown; packageDigest?: unknown; artifactDigest?: unknown; publisherKeyId?: unknown; publisherPublicKey?: unknown; publisherDisplayName?: unknown; appName?: unknown; appVersion?: unknown; description?: unknown; capabilities?: unknown; publicTemplate?: unknown; maxPlaintextBytes?: unknown; declaredMode?: unknown};

const validPersonalMetadata = (message: RendererMessage, baseKeys: string[]): boolean => {
  if ((!PERSONAL_MODE && !SHARED_MODE) || workerLifecycleState !== 'idle') return false;
  const fields = ['packageDigest', 'artifactDigest', 'publisherKeyId', 'publisherPublicKey', 'publisherDisplayName', 'appName', 'appVersion', 'description', 'capabilities', 'publicTemplate', 'maxPlaintextBytes', 'declaredMode'];
  if (!exactKeys(message, [...baseKeys, ...fields])) return false;
  const stringFields = fields.slice(0, 8);
  if (!stringFields.every((field) => typeof message[field as keyof RendererMessage] === 'string')) return false;
  if (!Array.isArray(message.capabilities) || !message.capabilities.every((value) => typeof value === 'string')) return false;
  if (!isPlainRecord(message.publicTemplate) || !Number.isSafeInteger(message.maxPlaintextBytes)) return false;
  return message.declaredMode === 'personal' || message.declaredMode === 'shared';
};

const rejectStateBatch = (requestId: unknown, code = 'STATE_INVALID', message = 'The bounded local operation batch was rejected.'): void => {
  post('sf.controller.result', {result: {requestId, kind: 'state', ok: false, error: {code, message}}});
};

const validateState = (state: Record<string, unknown>): Promise<{valid: boolean; error: string}> => new Promise((resolve) => {
  if (!isJsonValue(state)) { resolve({valid: false, error: 'STATE_JSON_INVALID'}); return; }
  const validationId = randomHex(16);
  const timer = window.setTimeout(() => {
    stateValidations.delete(validationId);
    resolve({valid: false, error: 'STATE_VALIDATION_TIMEOUT'});
  }, 2000);
  stateValidations.set(validationId, {resolve, timer});
  try { post('sf.controller.state.validate', {validationId, state}); }
  catch (_) { window.clearTimeout(timer); stateValidations.delete(validationId); resolve({valid: false, error: 'STATE_VALIDATION_UNAVAILABLE'}); }
});

const commitLocalState = (state: Record<string, unknown>): void => {
  localState = state;
  localRevision += 1;
  post('sf.controller.snapshot', {state: localState, role: executionRole(), online: navigator.onLine, revision: localRevision});
};
const replaceLocalState = async (state: Record<string, unknown>): Promise<void> => {
  if (stateMutationInFlight) throw new Error('STATE_BUSY');
  stateMutationInFlight = true;
  try {
    const start = Date.now();
    while (acceptedAppReadyGeneration === 0 && Date.now() - start < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = await validateState(state);
    if (!result.valid) throw new Error(result.error);
    commitLocalState(state);
  } finally {
    stateMutationInFlight = false;
  }
};

type StateOperation = {op: 'set' | 'delete'; path: string[]; value?: unknown};
const validStatePath = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= 16 && value.every((part) => typeof part === 'string' && part.length >= 1 && part.length <= 64 && !['__proto__', 'prototype', 'constructor'].includes(part));
const validStateOperation = (value: unknown): value is StateOperation => {
  if (!isPlainRecord(value) || (value.op !== 'set' && value.op !== 'delete') || !validStatePath(value.path)) return false;
  if (value.op === 'set') return exactKeys(value, ['op', 'path', 'value']) && isJsonValue(value.value);
  return exactKeys(value, ['op', 'path']);
};
const applyStateOperations = (state: Record<string, unknown>, operations: unknown[]): Record<string, unknown> | undefined => {
  const next = structuredClone(state);
  for (const operation of operations) {
    if (!validStateOperation(operation)) return undefined;
    let parent = next;
    for (const part of operation.path.slice(0, -1)) {
      const child = parent[part];
      if (!isPlainRecord(child)) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    const leaf = operation.path.at(-1) as string;
    if (operation.op === 'set') parent[leaf] = structuredClone(operation.value);
    else delete parent[leaf];
  }
  return next;
};

const dispatchStateBatch = (message: RendererMessage): void => {
  if (executionIsReadOnly()) { rejectStateBatch(message.requestId, 'READ_ONLY', 'Viewer simulation cannot change local state.'); return; }
  if (stateMutationInFlight) { rejectStateBatch(message.requestId, 'STATE_BUSY', 'Wait for the current local state validation.'); return; }
  if (!Array.isArray(message.operations) || message.operations.length < 1 || message.operations.length > 32) { rejectStateBatch(message.requestId); return; }
  const next = applyStateOperations(localState, message.operations);
  if (!next) { rejectStateBatch(message.requestId); return; }
  if (!PERSONAL_MODE && !SHARED_MODE) {
    commitLocalState(next);
    post('sf.controller.result', {result: {requestId: message.requestId, kind: 'state', ok: true}});
    return;
  }
  stateMutationInFlight = true;
  void validateState(next).then(async (result) => {
    if (!result.valid) { rejectStateBatch(message.requestId, result.error, 'The proposed state violates the signed package schema.'); return; }
    if (SHARED_MODE && personalSession) await personalSession.stateChanged(next, localRevision + 1);
    commitLocalState(next);
    post('sf.controller.result', {result: {requestId: message.requestId, kind: 'state', ok: true}});
    if (!SHARED_MODE && personalSession) void personalSession.stateChanged(localState, localRevision).catch(() => { byId<HTMLElement>('status').textContent = 'Local save failed; export before leaving.'; });
  }).catch(() => rejectStateBatch(message.requestId, 'LOCAL_COMMIT_FAILED', 'Local commit failed.')).finally(() => { stateMutationInFlight = false; });
};

const onPortMessage = (event: MessageEvent): void => {
  if (controllerChannelTerminal) return;
  if (event.ports.length !== 0) { terminateControllerChannel('CHANNEL_TRANSFER_FORBIDDEN', true); return; }
  const raw = event.data;
  const messageBytes = safeMessageBytes(raw);
  if (messageBytes > MAX_MESSAGE_BYTES) { terminateControllerChannel('CHANNEL_MESSAGE_TOO_LARGE', true); return; }
  if (!isPlainRecord(raw)) { terminateControllerChannel('CHANNEL_ENVELOPE_INVALID', true); return; }
  const message = raw as RendererMessage;
  if (message.channel !== 'smallframe-renderer' || message.protocol !== 1 || typeof message.type !== 'string' || !Number.isSafeInteger(message.sequence)) { terminateControllerChannel('CHANNEL_ENVELOPE_INVALID', true); return; }
  if (message.session !== activeSessionId) { terminateControllerChannel('CHANNEL_SESSION_INVALID', true); return; }
  if (message.sequence !== expectedPortSequence) { terminateControllerChannel('CHANNEL_SEQUENCE_REPLAY', true); return; }
  const baseKeys = ['channel', 'protocol', 'session', 'sequence', 'type'];
  let schemaValid = false;
  if (message.type === 'sf.renderer.rendered') schemaValid = exactKeys(message, baseKeys) && (!IS_CANDIDATE_U || (workerLifecycleState === 'running' && acceptedAppReadyGeneration === workerLifecycleGeneration));
  else if (message.type === 'sf.renderer.app-ready') {
    const expected = USES_CLASSIC_WORKER ? [...baseKeys, 'workerKind', 'blobCount', 'workerSelfOrigin', 'workerLocationOrigin', 'workerLocationHref', 'wasmStarted', 'wasmBytes', 'wasmProbe', 'wasmDigest', 'generation', 'restartCount', 'lastReason', ...(IS_CANDIDATE_U ? ['verifierStarted', 'verifierBytes', 'verifierVersion', 'verifierDigest'] : [])] : baseKeys;
    schemaValid = exactKeys(message, expected) && (!IS_CANDIDATE_U || (message.workerKind === 'classic-blob' && message.blobCount === 1 && message.workerSelfOrigin === 'null' && message.workerLocationOrigin === 'null' && typeof message.workerLocationHref === 'string' && message.workerLocationHref.startsWith('blob:null/') && message.wasmStarted === true && Number.isSafeInteger(message.wasmBytes) && message.wasmBytes === PHASE0_WASM_BYTES && message.wasmProbe === 0xf88bbfb9 && typeof message.wasmDigest === 'string' && /^[0-9a-f]{64}$/u.test(message.wasmDigest) && message.verifierStarted === true && Number.isSafeInteger(message.verifierBytes) && message.verifierBytes === PHASE1_WASM_BYTES && PHASE1_WASM_BYTES <= 2 * 1024 * 1024 && message.verifierVersion === 1 && typeof message.verifierDigest === 'string' && /^[0-9a-f]{64}$/u.test(message.verifierDigest) && Number.isSafeInteger(message.generation) && Number(message.generation) >= 1 && Number.isSafeInteger(message.restartCount) && Number(message.restartCount) >= 0 && typeof message.lastReason === 'string' && message.lastReason.length <= 64 && workerLifecycleState === 'running' && message.generation === workerLifecycleGeneration && message.restartCount === workerLifecycleRestartCount && acceptedAppReadyGeneration !== workerLifecycleGeneration));
  }
  else if (message.type === 'sf.renderer.worker-lifecycle') {
    const hasStopCode = Object.prototype.hasOwnProperty.call(message, 'stopCode');
    schemaValid = exactKeys(message, hasStopCode ? [...baseKeys, 'state', 'generation', 'restartCount', 'lastReason', 'stopCode'] : [...baseKeys, 'state', 'generation', 'restartCount', 'lastReason']) &&
      ['booting', 'running', 'restarting', 'stopped'].includes(String(message.state)) && Number.isSafeInteger(message.generation) && Number(message.generation) >= 1 && Number.isSafeInteger(message.restartCount) && Number(message.restartCount) >= 0 && typeof message.lastReason === 'string' && message.lastReason.length <= 64 && (!hasStopCode || (typeof message.stopCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(message.stopCode)));
    if (schemaValid) {
      const state = message.state as 'booting' | 'running' | 'restarting' | 'stopped';
      const generation = Number(message.generation);
      const restartCount = Number(message.restartCount);
      const transitionValid =
        (state === 'booting' && ((workerLifecycleState === 'idle' && generation === 1 && restartCount === 0) || (workerLifecycleState === 'restarting' && generation === workerLifecycleGeneration + 1 && restartCount === workerLifecycleRestartCount))) ||
        (state === 'running' && workerLifecycleState === 'booting' && generation === workerLifecycleGeneration && restartCount === workerLifecycleRestartCount) ||
        (state === 'restarting' && workerLifecycleState === 'running' && generation === workerLifecycleGeneration && restartCount === workerLifecycleRestartCount + 1) ||
        (state === 'stopped' && workerLifecycleState !== 'idle' && workerLifecycleState !== 'stopped' && generation === workerLifecycleGeneration && restartCount === workerLifecycleRestartCount);
      schemaValid = transitionValid;
      if (transitionValid) {
        workerLifecycleState = state;
        workerLifecycleGeneration = generation;
        workerLifecycleRestartCount = restartCount;
        if (state === 'booting' || state === 'restarting') acceptedAppReadyGeneration = 0;
      }
    }
  }
  else if (message.type === 'sf.renderer.state.batch') schemaValid = exactKeys(message, [...baseKeys, 'requestId', 'operations']) && typeof message.requestId === 'string' && /^[0-9a-f]{32}$/u.test(message.requestId) && (!IS_CANDIDATE_U || (workerLifecycleState === 'running' && acceptedAppReadyGeneration === workerLifecycleGeneration));
  else if (message.type === 'sf.renderer.state.validation') schemaValid = exactKeys(message, [...baseKeys, 'validationId', 'valid', 'error']) && typeof message.validationId === 'string' && /^[0-9a-f]{32}$/u.test(message.validationId) && typeof message.valid === 'boolean' && typeof message.error === 'string' && message.error.length <= 64;
  else if (message.type === 'sf.renderer.package-verified') schemaValid = validPersonalMetadata(message, baseKeys);
  else if (message.type === 'sf.renderer.error') {
    const withLifecycle = Object.prototype.hasOwnProperty.call(message, 'generation') || Object.prototype.hasOwnProperty.call(message, 'restartCount');
    schemaValid = exactKeys(message, withLifecycle ? [...baseKeys, 'error', 'generation', 'restartCount'] : [...baseKeys, 'error']) && typeof message.error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(message.error) && (!withLifecycle || (Number.isSafeInteger(message.generation) && Number.isSafeInteger(message.restartCount)));
  }
  if (!schemaValid) {
    terminateControllerChannel(message.type === 'sf.renderer.worker-lifecycle' ? 'CHANNEL_STATE_TRANSITION_INVALID' : 'CHANNEL_MESSAGE_SCHEMA', true);
    return;
  }
  window.clearTimeout(rendererInitTimer);
  expectedPortSequence += 1;
  try {
  if (message.type === 'sf.renderer.rendered') {
    byId<HTMLElement>('status').textContent = 'App Worker running; renderer accepted the declarative tree.';
  } else if (message.type === 'sf.renderer.app-ready') {
    acceptedAppReadyGeneration = Number(message.generation) || acceptedAppReadyGeneration;
    const host = byId<HTMLElement>('app-host');
    if (typeof message.workerKind === 'string') host.dataset.workerKind = message.workerKind;
    if (typeof message.blobCount === 'number') host.dataset.workerBlobCount = String(message.blobCount);
    if (typeof message.workerSelfOrigin === 'string') host.dataset.workerSelfOrigin = message.workerSelfOrigin;
    if (typeof message.workerLocationOrigin === 'string') host.dataset.workerLocationOrigin = message.workerLocationOrigin;
    if (typeof message.workerLocationHref === 'string') host.dataset.workerLocationHref = message.workerLocationHref;
    if (typeof message.wasmStarted === 'boolean') host.dataset.workerWasmStarted = String(message.wasmStarted);
    if (Number.isSafeInteger(message.wasmBytes)) host.dataset.workerWasmBytes = String(message.wasmBytes);
    if (Number.isSafeInteger(message.wasmProbe)) host.dataset.workerWasmProbe = String(message.wasmProbe);
    if (typeof message.wasmDigest === 'string') host.dataset.workerWasmDigest = message.wasmDigest;
    if (typeof message.verifierStarted === 'boolean') host.dataset.verifierStarted = String(message.verifierStarted);
    if (Number.isSafeInteger(message.verifierBytes)) host.dataset.verifierBytes = String(message.verifierBytes);
    if (Number.isSafeInteger(message.verifierVersion)) host.dataset.verifierVersion = String(message.verifierVersion);
    if (typeof message.verifierDigest === 'string') host.dataset.verifierDigest = message.verifierDigest;
    if (Number.isSafeInteger(message.generation)) host.dataset.workerGeneration = String(message.generation);
    if (Number.isSafeInteger(message.restartCount)) host.dataset.workerRestartCount = String(message.restartCount);
    if (typeof message.lastReason === 'string') host.dataset.workerLastReason = message.lastReason;
    injectControllerChannelFixture();
  } else if (message.type === 'sf.renderer.worker-lifecycle') {
    const host = byId<HTMLElement>('app-host');
    if (!['booting', 'running', 'restarting', 'stopped'].includes(String(message.state)) || !Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.restartCount) || typeof message.lastReason !== 'string' || (message.stopCode !== undefined && typeof message.stopCode !== 'string')) { port?.close(); renderControllerError(new Error('WORKER_LIFECYCLE_INVALID')); return; }
    host.dataset.workerState = String(message.state);
    host.dataset.workerGeneration = String(message.generation);
    host.dataset.workerRestartCount = String(message.restartCount);
    host.dataset.workerLastReason = message.lastReason;
    if (typeof message.stopCode === 'string') host.dataset.workerStopCode = message.stopCode;
    else delete host.dataset.workerStopCode;
    if (message.state === 'restarting') byId<HTMLElement>('status').textContent = `App Worker restarting after ${message.lastReason}.`;
  } else if (message.type === 'sf.renderer.package-verified') {
    if (!personalSession) { terminateControllerChannel('PERSONAL_SESSION_MISSING', true); return; }
    const metadata = {packageDigest: message.packageDigest, artifactDigest: message.artifactDigest, publisherKeyId: message.publisherKeyId, publisherPublicKey: message.publisherPublicKey, publisherDisplayName: message.publisherDisplayName, appName: message.appName, appVersion: message.appVersion, description: message.description, capabilities: message.capabilities, publicTemplate: message.publicTemplate, maxPlaintextBytes: message.maxPlaintextBytes, declaredMode: message.declaredMode} as PersonalPackageMetadata;
    void personalSession.handleVerified(metadata).catch((error: unknown) => terminateControllerChannel(error instanceof Error ? error.message : 'PERSONAL_SETUP_FAILED', true));
  } else if (message.type === 'sf.renderer.state.batch') {
    dispatchStateBatch(message);
  } else if (message.type === 'sf.renderer.state.validation') {
    const validation = stateValidations.get(message.validationId as string);
    if (!validation) { terminateControllerChannel('STATE_VALIDATION_UNEXPECTED', true); return; }
    window.clearTimeout(validation.timer);
    stateValidations.delete(message.validationId as string);
    validation.resolve({valid: message.valid as boolean, error: message.error as string});
  } else if (message.type === 'sf.renderer.error') {
    terminateControllerChannel(message.error as string);
  }
  } catch (_) {
    terminateControllerChannel('CHANNEL_DISPATCH_FAILED', true);
  }
};

const main = async (): Promise<void> => {
  const module = (window as Window & {SMALLFRAME_APP_MODULE?: string}).SMALLFRAME_APP_MODULE;
  if (!USES_CLASSIC_WORKER && !module) throw new Error('APP_MODULE_MISSING');
  if (SHARED_MODE && parsedInvite) {
    const binary = atob(PHASE2_PACKAGE_BASE64);
    personalArchive = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const sharedRuntime = (globalThis as typeof globalThis & {SmallframeSharedRuntime?: {createSession: (options: any) => PersonalSession}}).SmallframeSharedRuntime;
    if (!sharedRuntime) throw new Error('SHARED_RUNTIME_MISSING');
    personalSession = sharedRuntime.createSession({
      invite: parsedInvite,
      archive: personalArchive,
      apiOrigin: 'http://api.localhost:8787',
      onApprove: (state: Record<string, unknown>, role: 'viewer' | 'editor') => {
        sharedExecutionRole = role;
        localState = structuredClone(state);
        post('sf.controller.approval', {state: localState, role});
      },
      onReplaceState: async (state: Record<string, unknown>) => replaceLocalState(structuredClone(state))
    });
  } else if (PERSONAL_MODE) {
    const binary = atob(PHASE2_PACKAGE_BASE64);
    personalArchive = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const runtime = (globalThis as typeof globalThis & {SmallframePersonalRuntime?: {createSession: (options: {archive: Uint8Array; role: 'viewer' | 'editor'; onApprove: (state: Record<string, unknown>, role: 'viewer' | 'editor') => void; onReplaceState: (state: Record<string, unknown>) => Promise<void>}) => PersonalSession}}).SmallframePersonalRuntime;
    if (!runtime) throw new Error('PERSONAL_RUNTIME_MISSING');
    personalSession = runtime.createSession({archive: personalArchive, role: PERSONAL_ROLE, onApprove: (state, role) => { localState = structuredClone(state); post('sf.controller.approval', {state: localState, role}); }, onReplaceState: async (state) => replaceLocalState(structuredClone(state))});
  } else {
    byId<HTMLElement>('runtime-panel').hidden = false;
  }
  byId('status').textContent = (SHARED_MODE || PERSONAL_MODE) ? 'Verifying signed package…' : 'Verifying renderer…';
  const rendererHtml = await setupServiceWorker();
  await startFrame(rendererHtml);
};

const reopenRendererForPhase0 = async (): Promise<void> => {
  if (!IS_CANDIDATE_U) throw new Error('PHASE0_REOPEN_UNAVAILABLE');
  port?.close();
  port = undefined;
  frame?.remove();
  frame = undefined;
  await startFrame();
};

if (IS_CANDIDATE_U) {
  if (initialHash) history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  Object.defineProperty(window, '__smallframePhase0ReopenRenderer', {value: reopenRendererForPhase0, configurable: false, enumerable: false, writable: false});
}

void main().catch((error: unknown) => {
  if (IS_CANDIDATE_U) terminateControllerChannel(error instanceof Error ? error.message : 'CONTROLLER_STARTUP_FAILED', true);
  else renderControllerError(error);
});

export {};
