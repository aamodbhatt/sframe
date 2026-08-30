type ViewNode = {text: string} | {tag: string; key?: string; class?: string[]; children?: ViewNode[]; on?: Record<string, string>; props?: Record<string, unknown>};
const ARCHITECTURE_CANDIDATE: string = '__ARCHITECTURE_CANDIDATE__';
const CHANNEL_TEST_FIXTURE: string = '__CHANNEL_TEST_FIXTURE__';
const CANDIDATE_FACTORY_SOURCE: string = '__CANDIDATE_FACTORY_SOURCE__';
const PHASE0_WASM_BASE64 = '__PHASE0_WASM_BASE64__';
const PHASE0_WASM_SHA256 = '__PHASE0_WASM_SHA256__';
const PHASE0_WASM_BYTES = Number('__PHASE0_WASM_BYTES__');
const PHASE1_WASM_BASE64 = '__PHASE1_WASM_BASE64__';
const PHASE1_WASM_SHA256 = '__PHASE1_WASM_SHA256__';
const PHASE1_WASM_BYTES = Number('__PHASE1_WASM_BYTES__');
const USES_CLASSIC_WORKER = ARCHITECTURE_CANDIDATE === 'S' || ARCHITECTURE_CANDIDATE === 'T' || ARCHITECTURE_CANDIDATE === 'U';
const IS_CANDIDATE_U = ARCHITECTURE_CANDIDATE === 'U';
type PortMessage = {channel: string; protocol: 1; session: string; sequence: number; type: string; [key: string]: unknown};
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const MAX_MESSAGE_BYTES = 256 * 1024;
const ALLOWED_TAGS = new Set(['div', 'section', 'header', 'footer', 'main', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'button', 'label', 'input', 'textarea', 'select', 'option', 'progress', 'meter', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre', 'hr', 'br']);
const ALLOWED_CLASSES = new Set(['sf-stack', 'sf-row', 'sf-grid', 'sf-card', 'sf-actions', 'sf-grow', 'sf-compact', 'sf-muted', 'sf-emphasis', 'sf-sr-only']);
const EVENTS = new Set(['click', 'input', 'change', 'submitIntent']);
const ELEMENT_LIMIT = 2000;
let port: MessagePort | undefined;
let worker: Worker | undefined;
let outgoingSequence = 0;
let incomingSequence = 1;
let workerOutgoingSequence = 0;
let workerIncomingSequence = 1;
let invalidTreeCount = 0;
let nonce = '';
let sessionId = '';
let initAccepted = false;
let parentChannelTerminal = false;
let rendererChannelFixtureInjected = false;
let currentState: unknown = {decisions: {}};
let classicWorkerSession = '';
let classicWorkerOutgoingSequence = 0;
let classicWorkerIncomingSequence = 1;
let classicWorkerBlobUrl = '';
let classicWorkerPayload = '';
let classicWorkerReady = false;
let classicWorkerRestarting = false;
let classicWorkerReadyTimer = 0;
let classicWorkerBusyTimer = 0;
let classicWorkerPort: MessagePort | undefined;
let classicWorkerBootstrapKey = '';
let classicWorkerGeneration = 0;
let classicWorkerRestartCount = 0;
let classicWorkerLastReason = '';
let classicWorkerTerminal = false;
type Phase1VerifierGlue = {
  initSync: (options: {module: Uint8Array}) => unknown;
  wasm_sha256_hex: (input: Uint8Array) => string;
  wasm_prepare_package: (archive: Uint8Array, expectedDigest: string, expectedKeyId: string) => string;
  wasm_verifier_self_test: () => boolean;
  wasm_verifier_version: () => number;
  wasm_verify_package: (archive: Uint8Array, expectedDigest: string, expectedKeyId: string) => string;
};
let phase1Verifier: Phase1VerifierGlue | undefined;
let phase1VerifierStarted = false;
let preparedModuleSource = '';
let packageApprovalPending = false;
const startPhase1Verifier = (): boolean => {
  try {
    const glue = (globalThis as typeof globalThis & {__smallframePhase1Verifier?: Phase1VerifierGlue}).__smallframePhase1Verifier;
    if (!glue || PHASE1_WASM_BYTES <= 8 || PHASE1_WASM_BYTES > 2 * 1024 * 1024 || !/^[0-9a-f]{64}$/u.test(PHASE1_WASM_SHA256)) return false;
    const binary = atob(PHASE1_WASM_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength !== PHASE1_WASM_BYTES) return false;
    glue.initSync({module: bytes});
    if (glue.wasm_verifier_version() !== 1 || !glue.wasm_verifier_self_test()) return false;
    if (glue.wasm_sha256_hex(bytes) !== PHASE1_WASM_SHA256) return false;
    phase1Verifier = glue;
    return true;
  } catch (_) {
    phase1Verifier = undefined;
    return false;
  }
};
const verifyPhase1Package = (archive: Uint8Array, expectedDigest = '', expectedKeyId = ''): unknown => {
  if (!phase1VerifierStarted || !phase1Verifier) throw new Error('PHASE1_VERIFIER_NOT_READY');
  return JSON.parse(phase1Verifier.wasm_verify_package(archive, expectedDigest, expectedKeyId));
};
void verifyPhase1Package;
type PreparedPackage = {ok: true; packageDigest: string; artifactDigest: string; publisherKeyId: string; manifest: Record<string, unknown>; moduleSource: string};
const preparePhase2Package = (archive: Uint8Array, expectedDigest: string, expectedKeyId: string): PreparedPackage => {
  if (!phase1VerifierStarted || !phase1Verifier) throw new Error('PHASE1_VERIFIER_NOT_READY');
  const result = JSON.parse(phase1Verifier.wasm_prepare_package(archive, expectedDigest, expectedKeyId)) as Partial<PreparedPackage> & {error?: {code?: unknown}};
  if (result.ok !== true) throw new Error(typeof result.error?.code === 'string' ? result.error.code : 'PACKAGE_VERIFY_FAILED');
  if (!isPlainRecord(result.manifest) || typeof result.moduleSource !== 'string' || result.moduleSource.length > 786432 || typeof result.packageDigest !== 'string' || typeof result.artifactDigest !== 'string' || typeof result.publisherKeyId !== 'string') throw new Error('PACKAGE_VERIFY_RESULT_INVALID');
  return result as PreparedPackage;
};
type WorkerTrustedTypesPolicy = {createScriptURL: (url: string) => unknown};
let workerPolicy: WorkerTrustedTypesPolicy | undefined;

const sizeOf = (value: unknown): number => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new Error('MESSAGE_NOT_JSON');
  return new TextEncoder().encode(encoded).byteLength;
};
const safeSizeOf = (value: unknown): number => {
  try { return sizeOf(value); } catch (_) { return Number.POSITIVE_INFINITY; }
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
const randomBase64Url = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const workerScriptUrl = (value: string): string => {
  const types = (globalThis as {trustedTypes?: {createPolicy: (name: string, rules: {createScriptURL: (url: string) => string}) => WorkerTrustedTypesPolicy}}).trustedTypes;
  if (!types) return value;
  workerPolicy ??= types.createPolicy('smallframe-renderer-worker', {createScriptURL: (url) => url.startsWith('blob:') ? url : (() => { throw new Error('WORKER_URL_NOT_ALLOWED'); })()});
  return workerPolicy.createScriptURL(value) as string;
};
const sendParent = (type: string, body: Record<string, unknown> = {}): void => {
  if (!port || parentChannelTerminal || !sessionId) return;
  if (Reflect.ownKeys(body).some((key) => typeof key !== 'string' || ['channel', 'protocol', 'session', 'sequence', 'type'].includes(key))) throw new Error('CHANNEL_INTERNAL_SCHEMA');
  const nextSequence = outgoingSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error('CHANNEL_SEQUENCE_EXHAUSTED');
  const message = {channel: 'smallframe-renderer', protocol: 1, session: sessionId, sequence: nextSequence, type, ...body};
  if (sizeOf(message) > MAX_MESSAGE_BYTES) throw new Error('CHANNEL_MESSAGE_TOO_LARGE');
  port.postMessage(message);
  outgoingSequence = nextSequence;
  if (type === 'sf.renderer.app-ready') injectRendererChannelFixture(message);
};

const injectRendererChannelFixture = (acceptedMessage: Record<string, unknown>): void => {
  if (!IS_CANDIDATE_U || rendererChannelFixtureInjected || !port || !sessionId || !CHANNEL_TEST_FIXTURE.startsWith('renderer-')) return;
  rendererChannelFixtureInjected = true;
  const sequence = CHANNEL_TEST_FIXTURE === 'renderer-replay' ? outgoingSequence : outgoingSequence + 1;
  const base = {channel: 'smallframe-renderer', protocol: 1, session: sessionId, sequence};
  if (CHANNEL_TEST_FIXTURE === 'renderer-wrong-session') port.postMessage({...base, session: randomBase64Url(16), type: 'sf.renderer.rendered'});
  else if (CHANNEL_TEST_FIXTURE === 'renderer-extra-key') port.postMessage({...base, type: 'sf.renderer.rendered', unexpected: true});
  else if (CHANNEL_TEST_FIXTURE === 'renderer-unknown-type') port.postMessage({...base, type: 'sf.renderer.unknown'});
  else if (CHANNEL_TEST_FIXTURE === 'renderer-oversized') port.postMessage({...base, type: 'sf.renderer.rendered', oversized: 'x'.repeat(MAX_MESSAGE_BYTES)});
  else if (CHANNEL_TEST_FIXTURE === 'renderer-duplicate-ready') port.postMessage({...acceptedMessage, sequence: outgoingSequence + 1});
  else if (CHANNEL_TEST_FIXTURE === 'renderer-transfer') {
    const transferred = new MessageChannel();
    port.postMessage({...base, type: 'sf.renderer.rendered'}, [transferred.port2]);
    window.setTimeout(() => transferred.port1.close(), 1000);
  }
  else port.postMessage({...base, type: 'sf.renderer.rendered'});
};
const sendClassicWorker = (type: string, body: Record<string, unknown> = {}): void => {
  if (!classicWorkerPort || !classicWorkerReady || !classicWorkerSession) return;
  if (Reflect.ownKeys(body).some((key) => typeof key !== 'string' || ['channel', 'protocol', 'session', 'sequence', 'type'].includes(key))) throw new Error('WORKER_INTERNAL_SCHEMA');
  const nextSequence = classicWorkerOutgoingSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error('WORKER_SEQUENCE_EXHAUSTED');
  const message = {channel: 'smallframe-controller', protocol: 1, session: classicWorkerSession, sequence: nextSequence, type, ...body};
  if (sizeOf(message) > MAX_MESSAGE_BYTES) throw new Error('WORKER_MESSAGE_TOO_LARGE');
  classicWorkerPort.postMessage(message);
  classicWorkerOutgoingSequence = nextSequence;
};
const sendWorker = (type: string, body: Record<string, unknown> = {}): void => {
  if (USES_CLASSIC_WORKER) {
    sendClassicWorker(type, body);
    if (type === 'event') {
      window.clearTimeout(classicWorkerBusyTimer);
      classicWorkerBusyTimer = window.setTimeout(() => restartClassicWorker('WORKER_WATCHDOG_TIMEOUT'), 1000);
    }
    return;
  }
  if (!worker) return;
  const nextSequence = workerOutgoingSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error('WORKER_SEQUENCE_EXHAUSTED');
  const message = {protocol: 1, sequence: nextSequence, type, ...body};
  if (sizeOf(message) > MAX_MESSAGE_BYTES) throw new Error('WORKER_MESSAGE_TOO_LARGE');
  worker.postMessage(message);
  workerOutgoingSequence = nextSequence;
};
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);

function validateTree(node: unknown): asserts node is ViewNode {
  let count = 0;
  const visit = (candidate: unknown, depth: number, parentTag?: string): void => {
    count += 1;
    if (count > ELEMENT_LIMIT || depth > 32) throw new Error('VIEW_LIMIT');
    if (typeof candidate === 'object' && candidate !== null && 'text' in candidate) {
      const text = (candidate as {text?: unknown}).text;
      if (!boundedString(text, 10000)) throw new Error('VIEW_TEXT_INVALID');
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) throw new Error('VIEW_NODE_INVALID');
    const value = candidate as Record<string, unknown>;
    if (typeof value.tag !== 'string' || !ALLOWED_TAGS.has(value.tag)) throw new Error('VIEW_TAG_INVALID');
    if (parentTag === 'ul' || parentTag === 'ol') {
      if (value.tag !== 'li') throw new Error('VIEW_CHILD_SHAPE');
    }
    if (parentTag === 'dl' && !['dt', 'dd'].includes(value.tag)) throw new Error('VIEW_CHILD_SHAPE');
    if (['hr', 'br', 'input', 'progress', 'meter'].includes(value.tag) && value.children !== undefined) throw new Error('VIEW_LEAF_CHILDREN');
    if (value.key !== undefined && !boundedString(value.key, 64)) throw new Error('VIEW_KEY_INVALID');
    if (value.class !== undefined && (!Array.isArray(value.class) || value.class.length > 8 || [...value.class].some((item) => !boundedString(item, 32) || !ALLOWED_CLASSES.has(item)))) throw new Error('VIEW_CLASS_INVALID');
    if (value.on !== undefined && (typeof value.on !== 'object' || value.on === null || Object.entries(value.on).some(([event, action]) => !EVENTS.has(event) || !boundedString(action, 64)))) throw new Error('VIEW_EVENT_INVALID');
    if (value.props !== undefined && (typeof value.props !== 'object' || value.props === null)) throw new Error('VIEW_PROPS_INVALID');
    if (value.children !== undefined && (!Array.isArray(value.children) || value.children.length > ELEMENT_LIMIT)) throw new Error('VIEW_CHILDREN_INVALID');
    for (const child of (value.children ?? [])) visit(child, depth + 1, value.tag);
  };
  visit(node, 0);
  if (sizeOf(node) > 200 * 1024) throw new Error('VIEW_BYTES_LIMIT');
}

const applyProps = (element: HTMLElement, value: Record<string, unknown>): void => {
  const props = value.props;
  if (props === undefined || typeof props !== 'object' || props === null) return;
  for (const [key, raw] of Object.entries(props)) {
    if (key === 'title' && boundedString(raw, 256)) element.title = raw;
    else if (key === 'hidden' && typeof raw === 'boolean') element.hidden = raw;
    else if (key === 'aria-label' && boundedString(raw, 256)) element.setAttribute('aria-label', raw);
    else if (key === 'aria-description' && boundedString(raw, 512)) element.setAttribute('aria-description', raw);
    else if (key === 'aria-live' && (raw === 'off' || raw === 'polite')) element.setAttribute('aria-live', raw);
    else if (key.startsWith('aria-') && (typeof raw === 'boolean' || typeof raw === 'number' || boundedString(raw, 512))) element.setAttribute(key, String(raw));
    else if (key === 'disabled' && typeof raw === 'boolean' && 'disabled' in element) (element as HTMLButtonElement | HTMLInputElement).disabled = raw;
    else if (key === 'value' && (typeof raw === 'string' || typeof raw === 'number') && 'value' in element) (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = String(raw);
    else if (key === 'checked' && typeof raw === 'boolean' && element instanceof HTMLInputElement) element.checked = raw;
    else if (key === 'placeholder' && boundedString(raw, 256) && 'placeholder' in element) (element as HTMLInputElement | HTMLTextAreaElement).placeholder = raw;
    else if (key === 'class') throw new Error('CLASS_MUST_BE_TOP_LEVEL');
    else if (!['required', 'maxlength', 'rows', 'type', 'name', 'min', 'max', 'step', 'selected', 'scope', 'groupKey', 'autocomplete'].includes(key)) throw new Error('VIEW_PROP_FORBIDDEN');
  }
};

const buildNode = (node: ViewNode): Node => {
  if ('text' in node) return document.createTextNode(node.text);
  const element = document.createElement(node.tag);
  if (node.class) element.className = [...node.class].sort().join(' ');
  applyProps(element, node);
  for (const child of node.children ?? []) element.appendChild(buildNode(child));
  for (const [event, action] of Object.entries(node.on ?? {})) {
    if (event === 'click' || event === 'submitIntent') element.addEventListener('click', () => sendWorker('event', {event: {action}}));
    else if (event === 'input' || event === 'change') element.addEventListener(event, () => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      sendWorker('event', {event: {action, key: node.key ?? '', value: boundedString(control.value, 32768) ? control.value : '', checked: control instanceof HTMLInputElement ? control.checked : undefined}});
    });
  }
  return element;
};

const displayTree = (tree: unknown): void => {
  try {
    validateTree(tree);
    const root = document.getElementById('sf-app-root');
    if (!root) throw new Error('VIEW_ROOT_MISSING');
    root.replaceChildren(buildNode(tree));
    invalidTreeCount = 0;
    window.clearTimeout(classicWorkerBusyTimer);
    sendParent('sf.renderer.rendered');
  } catch (error) {
    invalidTreeCount += 1;
    if (invalidTreeCount >= 3) worker?.terminate();
    sendParent('sf.renderer.error', {error: error instanceof Error ? error.message : 'VIEW_INVALID'});
  }
};

const appBootstrap = (appUrl: string): string => `
const deny = (name) => () => { throw new Error(name + '_DENIED'); };
for (const name of ['fetch','WebSocket','EventSource','WebTransport','XMLHttpRequest','importScripts','Worker','SharedWorker','BroadcastChannel']) {
  try { Object.defineProperty(globalThis, name, {value: deny(name), configurable: false, writable: false}); } catch (_) {}
}
const pending = new Set();
const id = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2,'0')).join(''); };
const defineApp = (descriptor) => {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.view !== 'function' || typeof descriptor.onEvent !== 'function' || Object.keys(descriptor).some(k => !['view','onEvent','onResult'].includes(k))) throw new Error('APP_ABI_INVALID');
  return Object.freeze({view: descriptor.view, onEvent: descriptor.onEvent, ...(descriptor.onResult ? {onResult: descriptor.onResult} : {})});
};
const h = (tag, props = {}, children = []) => ({tag, ...(props.key ? {key: props.key} : {}), ...(props.class ? {class: props.class} : {}), ...(props.on ? {on: props.on} : {}), ...(Object.keys(props).some(k => !['key','class','on','children'].includes(k)) ? {props: Object.fromEntries(Object.entries(props).filter(([k]) => !['key','class','on','children'].includes(k)))} : {}), children});
const text = (value) => ({text: String(value)});
globalThis.SmallframeSDK = Object.freeze({defineApp, h, text});
const post = (message) => self.postMessage({protocol:1, ...message});
let descriptor;
try {
  const types = globalThis.trustedTypes;
  const appImportUrl = (() => {
    if (!types) return ${JSON.stringify(appUrl)};
    const policy = types.createPolicy('smallframe-renderer-worker', {createScriptURL: (url) => url === ${JSON.stringify(appUrl)} ? url : (() => { throw new Error('APP_URL_NOT_ALLOWED'); })()});
    return policy.createScriptURL(${JSON.stringify(appUrl)});
  })();
  const mod = await import(appImportUrl);
  descriptor = mod.default;
  if (!descriptor || typeof descriptor.view !== 'function' || typeof descriptor.onEvent !== 'function') throw new Error('APP_ABI_INVALID');
  post({type:'ready'});
} catch (error) { post({type:'error', error: error instanceof Error ? error.message : 'APP_BOOT_FAILED'}); }
self.onmessage = (event) => {
  const message = event.data;
  if (!descriptor || message?.protocol !== 1) return;
  try {
    const stateView = structuredClone(message.state);
    Object.defineProperty(stateView, 'batch', {value: (operations) => { const requestId = id(); if (pending.size >= 32) return; pending.add(requestId); post({type:'state.batch', requestId, operations}); }, enumerable: false});
    const context = {state: Object.freeze(stateView), role: message.role, online: message.online, revision: message.revision, randomId: id, now: () => Math.floor(Date.now()/1000)};
    if (message.type === 'snapshot') post({type:'render', tree: descriptor.view(context)});
    else if (message.type === 'event') { descriptor.onEvent(message.event, context); post({type:'render', tree: descriptor.view(context)}); }
    else if (message.type === 'result') { if (typeof descriptor.onResult === 'function') descriptor.onResult(Object.freeze(message.result), context); pending.delete(message.result.requestId); post({type:'render', tree: descriptor.view(context)}); }
  } catch (error) { post({type:'error', error: error instanceof Error ? error.message : 'APP_RUNTIME_FAILED'}); }
};`;

const classicBlobWorkerSource = (): string => `
(() => {
  const pristinePostMessage = self.postMessage.bind(self);
  const pristineAddEventListener = self.addEventListener.bind(self);
  const pristineRemoveEventListener = self.removeEventListener.bind(self);
  const pristineStructuredClone = globalThis.structuredClone.bind(globalThis);
  const pristineGetRandomValues = crypto.getRandomValues.bind(crypto);
  const pristineFreeze = Object.freeze.bind(Object);
  const pristineKeys = Object.keys.bind(Object);
  const pristineDefineProperty = Object.defineProperty.bind(Object);
  const pristineDeleteProperty = Reflect.deleteProperty.bind(Reflect);
  const pristineHasOwn = Object.prototype.hasOwnProperty;
  const pristineIsPrototypeOf = Object.prototype.isPrototypeOf;
  const pristineSort = Array.prototype.sort;
  const pristineEncode = TextEncoder.prototype.encode.bind(new TextEncoder());
  const pristineStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const pristinePortAddEventListener = MessagePort.prototype.addEventListener;
  const pristinePortStart = MessagePort.prototype.start;
  const pristinePortPostMessage = MessagePort.prototype.postMessage;
  const pristinePortClose = MessagePort.prototype.close;
  const messagePortPrototype = MessagePort.prototype;
  const objectPrototype = Object.prototype;
  const sessionBytes = new Uint8Array(16);
  pristineGetRandomValues(sessionBytes);
  const session = Array.from(sessionBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  let outgoingSequence = 0;
  let incomingSequence = 1;
  let registrationState = 'open';
  let descriptor;
  let privatePort;
  let bootstrapAccepted = false;
  let savedSnapshot;
  const pending = new Set();
  const deny = (name) => () => { throw new Error(name + '_DENIED'); };
  const isPlainObject = (value) => value !== null && typeof value === 'object' && pristineIsPrototypeOf.call(objectPrototype, value);
  const exactKeys = (value, required) => {
    if (!isPlainObject(value)) return false;
    const keys = pristineSort.call(pristineKeys(value));
    const expected = pristineSort.call([...required]);
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  };
  const isMessagePort = (value) => value !== null && typeof value === 'object' && pristineIsPrototypeOf.call(messagePortPrototype, value);
  const messageBytes = (value) => pristineEncode(JSON.stringify(value)).byteLength;
  const send = (type, body = {}) => {
    if (!privatePort) throw new Error('WORKER_CHANNEL_MISSING');
    const cloned = pristineStructuredClone(body);
    const message = {channel: 'smallframe-prelude', protocol: 1, session, sequence: ++outgoingSequence, type, ...cloned};
    if (messageBytes(message) > 262144) throw new Error('WORKER_MESSAGE_TOO_LARGE');
    pristinePortPostMessage.call(privatePort, message);
  };
  const fail = (error) => {
    try { send('error', {error: error instanceof Error ? error.message : 'WORKER_PROTOCOL_ERROR'}); } catch (_) {}
  };
  const boundedId = () => {
    const bytes = new Uint8Array(16);
    pristineGetRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const deepFreeze = (value, seen = new Set()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of pristineKeys(value)) deepFreeze(value[key], seen);
    return pristineFreeze(value);
  };
  const isThenable = (value) => value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
  const validDescriptor = (candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('APP_ABI_INVALID');
    let encoded;
    try { encoded = pristineEncode(JSON.stringify(candidate, (_, child) => typeof child === 'function' ? '[function]' : child)).byteLength; } catch (_) { throw new Error('APP_DESCRIPTOR_INVALID'); }
    if (encoded > 262144) throw new Error('APP_DESCRIPTOR_TOO_LARGE');
    const keys = pristineSort.call(pristineKeys(candidate));
    if (keys.some((key, index) => key === keys[index - 1]) || keys.some((key) => !['onEvent', 'onResult', 'view'].includes(key))) throw new Error('APP_ABI_INVALID');
    if (typeof candidate.view !== 'function' || typeof candidate.onEvent !== 'function') throw new Error('APP_ABI_INVALID');
    if (candidate.onResult !== undefined && typeof candidate.onResult !== 'function') throw new Error('APP_ABI_INVALID');
    return pristineFreeze({view: candidate.view, onEvent: candidate.onEvent, ...(candidate.onResult ? {onResult: candidate.onResult} : {})});
  };
  const register = (factory) => {
    if (registrationState !== 'open') throw new Error(registrationState === 'registering' ? 'APP_REENTRANT_REGISTRATION' : 'APP_DUPLICATE_REGISTRATION');
    if (typeof factory !== 'function') throw new Error('APP_ABI_INVALID');
    registrationState = 'registering';
    try {
      const candidate = factory();
      if (isThenable(candidate)) throw new Error('APP_ASYNC_FACTORY');
      descriptor = validDescriptor(candidate);
      registrationState = 'registered';
    } catch (error) {
      registrationState = 'failed';
      throw error;
    }
  };
  const requestBatch = (operations) => {
    if (pending.size >= 32) throw new Error('TOO_MANY_PENDING');
    const requestId = boundedId();
    pending.add(requestId);
    send('state.batch', {requestId, operations: pristineStructuredClone(operations)});
    return requestId;
  };
  const freshContext = () => {
    if (!savedSnapshot) throw new Error('SNAPSHOT_MISSING');
    const state = pristineStructuredClone(savedSnapshot.state);
    if (!isPlainObject(state)) throw new Error('SNAPSHOT_STATE_INVALID');
    pristineDefineProperty(state, 'batch', {value: requestBatch, enumerable: false, writable: false, configurable: false});
    return deepFreeze({state: deepFreeze(state), role: savedSnapshot.role, online: savedSnapshot.online, revision: savedSnapshot.revision, randomId: boundedId, now: () => Math.floor(Date.now() / 1000)});
  };
  const renderTree = (tree) => send('render', {tree: pristineStructuredClone(tree)});
  const renderSnapshot = (message) => {
    if (!isPlainObject(message) || !isPlainObject(message.state) || !['editor', 'viewer'].includes(message.role) || typeof message.online !== 'boolean' || !Number.isSafeInteger(message.revision) || message.revision < 0) throw new Error('SNAPSHOT_INVALID');
    savedSnapshot = deepFreeze({state: pristineStructuredClone(message.state), role: message.role, online: message.online, revision: message.revision});
    const context = freshContext();
    const result = descriptor.view(context);
    if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    renderTree(result);
  };
  const renderEvent = (message) => {
    if (!isPlainObject(message.event)) throw new Error('EVENT_INVALID');
    const before = pending.size;
    const result = descriptor.onEvent(message.event, freshContext());
    if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    if (pending.size === before) renderTree(descriptor.view(freshContext()));
  };
  const renderResult = (message) => {
    if (!isPlainObject(message.result) || typeof message.result.requestId !== 'string' || !pending.has(message.result.requestId)) throw new Error('RESULT_ID_INVALID');
    pending.delete(message.result.requestId);
    if (typeof descriptor.onResult === 'function') {
      const result = descriptor.onResult(pristineStructuredClone(message.result), freshContext());
      if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    }
    renderTree(descriptor.view(freshContext()));
  };
  const onPrivateMessage = (event) => {
    const message = event.data;
    if (!isPlainObject(message) || message.channel !== 'smallframe-controller' || message.protocol !== 1 || message.session !== session || message.sequence !== incomingSequence || !Number.isSafeInteger(message.sequence) || messageBytes(message) > 262144) { fail('WORKER_MESSAGE_REPLAY'); return; }
    incomingSequence += 1;
    try {
      if (message.type === 'snapshot' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'state', 'role', 'online', 'revision'])) renderSnapshot(message);
      else if (message.type === 'event' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'event'])) renderEvent(message);
      else if (message.type === 'result' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'result'])) renderResult(message);
      else throw new Error('WORKER_MESSAGE_SCHEMA');
    } catch (error) { fail(error); }
  };
  const runPublisher = () => {
    try {
      (() => {
${CANDIDATE_FACTORY_SOURCE}
      })();
      if (registrationState !== 'registered') throw new Error('APP_FACTORY_MISSING');
      registrationState = 'sealed';
      pristineDeleteProperty(globalThis, '__smallframe_register');
      send('prelude-ready', {workerKind: 'classic-blob', blobCount: 1, dynamicImport: false, importScripts: false, workerSelfOrigin: self.origin, workerLocationOrigin: location.origin, workerLocationHref: location.href});
    } catch (error) { fail(error); }
  };
  const bootstrapMessage = (event) => {
    try { pristineStopImmediatePropagation.call(event); } catch (_) {}
    if (bootstrapAccepted || event.isTrusted !== true || !exactKeys(event.data, ['channel', 'protocol', 'type', 'key']) || event.data.channel !== 'smallframe-bootstrap' || event.data.protocol !== 1 || event.data.type !== 'attach' || typeof event.data.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(event.data.key) || !event.ports || event.ports.length !== 1 || !isMessagePort(event.ports[0])) return;
    if (event.data.key !== bootstrapKey) return;
    bootstrapAccepted = true;
    pristineRemoveEventListener('message', bootstrapMessage);
    privatePort = event.ports[0];
    pristinePortAddEventListener.call(privatePort, 'message', onPrivateMessage);
    pristinePortStart.call(privatePort);
    runPublisher();
  };
  const bootstrapKey = '__BOOTSTRAP_KEY_FROM_RENDERER__';
  pristineAddEventListener('message', bootstrapMessage, true);
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'WebTransport', 'XMLHttpRequest', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel']) {
    try { pristineDefineProperty(globalThis, name, {value: deny(name), configurable: false, writable: false}); } catch (_) {}
  }
  try { pristineDefineProperty(globalThis, 'postMessage', {value: deny('publisher.postMessage'), configurable: false, writable: false}); } catch (_) {}
  pristineDefineProperty(globalThis, '__smallframe_register', {value: register, configurable: true, writable: false});
})();
`;

const candidateUBlobWorkerSource = (publisherSource = CANDIDATE_FACTORY_SOURCE): string => `
const __smallframePublisherEntry = (__smallframeRegister) => {
  'use strict';
${publisherSource}
};

(() => {
  'use strict';

  // Capture every intrinsic used after publisher execution. Calls go through
  // the captured Reflect.apply function, never a dynamically resolved .call
  // or .apply property.
  const safeApply = Reflect.apply;
  const trustedGetRandomValues = crypto.getRandomValues;
  const trustedFreeze = Object.freeze;
  const trustedKeys = Object.keys;
  const trustedOwnKeys = Reflect.ownKeys;
  const trustedHasOwnProperty = Object.prototype.hasOwnProperty;
  const trustedDefineProperty = Object.defineProperty;
  const trustedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const trustedGetPrototypeOf = Object.getPrototypeOf;
  const trustedCreate = Object.create;
  const trustedSetPrototypeOf = Object.setPrototypeOf;
  const trustedDeleteProperty = Reflect.deleteProperty;
  const trustedReflectGet = Reflect.get;
  const trustedSort = Array.prototype.sort;
  const trustedSlice = Array.prototype.slice;
  const trustedJoin = Array.prototype.join;
  const trustedArrayIsArray = Array.isArray;
  const trustedStringify = JSON.stringify;
  const trustedNumberIsSafeInteger = Number.isSafeInteger;
  const trustedNumberIsFinite = Number.isFinite;
  const trustedDateNow = Date.now;
  const trustedMathFloor = Math.floor;
  const trustedNumberToString = Number.prototype.toString;
  const trustedPadStart = String.prototype.padStart;
  const trustedRegExpTest = RegExp.prototype.test;
  const trustedSet = Set;
  const trustedSetHas = Set.prototype.has;
  const trustedSetAdd = Set.prototype.add;
  const trustedSetDelete = Set.prototype.delete;
  const trustedSetSize = trustedGetOwnPropertyDescriptor(Set.prototype, 'size')?.get;
  const trustedEncodeTarget = new TextEncoder();
  const trustedEncode = TextEncoder.prototype.encode;
  const trustedTypedArrayByteLength = trustedGetOwnPropertyDescriptor(trustedGetPrototypeOf(Uint8Array.prototype), 'byteLength')?.get;
  const trustedGlobalAddEventListener = self.addEventListener;
  const trustedGlobalRemoveEventListener = self.removeEventListener;
  const trustedStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const trustedPortAddEventListener = MessagePort.prototype.addEventListener;
  const trustedPortStart = MessagePort.prototype.start;
  const trustedPortPostMessage = MessagePort.prototype.postMessage;
  const trustedPortClose = MessagePort.prototype.close;
  const messagePortPrototype = MessagePort.prototype;
  const objectPrototype = Object.prototype;
  const eventIsTrustedGetter = trustedGetOwnPropertyDescriptor(Event.prototype, 'isTrusted')?.get;
  const messageDataGetter = trustedGetOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  const messagePortsGetter = trustedGetOwnPropertyDescriptor(MessageEvent.prototype, 'ports')?.get;
  if (typeof trustedSetSize !== 'function' || typeof trustedTypedArrayByteLength !== 'function' || typeof messageDataGetter !== 'function' || typeof messagePortsGetter !== 'function') throw new Error('PRELUDE_INTRINSIC_MISSING');

  let phase0WasmStarted = false;
  let phase0WasmBytes = 0;
  let phase0WasmProbe = 0;
  const phase0WasmDigest = '${PHASE0_WASM_SHA256}';
  try {
    const binary = atob('${PHASE0_WASM_BASE64}');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module);
    const probe = instance.exports.smallframe_phase0_probe;
    if (typeof probe !== 'function') throw new Error('PHASE0_WASM_EXPORT_MISSING');
    phase0WasmProbe = safeApply(probe, undefined, [0x13579bdf]) >>> 0;
    phase0WasmBytes = bytes.byteLength;
    phase0WasmStarted = phase0WasmProbe === 0xf88bbfb9 && phase0WasmBytes === ${PHASE0_WASM_BYTES} && phase0WasmBytes > 8 && phase0WasmBytes <= 65536 && /^[0-9a-f]{64}$/u.test(phase0WasmDigest);
  } catch (_) {
    phase0WasmStarted = false;
  }

  const encode = (value) => safeApply(trustedEncode, trustedEncodeTarget, [value]);
  const random = (value) => safeApply(trustedGetRandomValues, crypto, [value]);
  const setHas = (set, value) => safeApply(trustedSetHas, set, [value]);
  const setAdd = (set, value) => safeApply(trustedSetAdd, set, [value]);
  const setDelete = (set, value) => safeApply(trustedSetDelete, set, [value]);
  const setSize = (set) => safeApply(trustedSetSize, set, []);
  const hasOwn = (value, key) => safeApply(trustedHasOwnProperty, value, [key]);
  const byteLength = (value) => safeApply(trustedTypedArrayByteLength, value, []);
  const eventIsTrusted = (event) => {
    const own = trustedGetOwnPropertyDescriptor(event, 'isTrusted');
    if (own && hasOwn(own, 'value')) return own.value === true;
    if (typeof eventIsTrustedGetter === 'function') return safeApply(eventIsTrustedGetter, event, []) === true;
    return event.isTrusted === true;
  };
  const ownStringKeysSorted = (value) => {
    const keys = safeApply(trustedOwnKeys, undefined, [value]);
    for (let index = 0; index < keys.length; index += 1) if (typeof keys[index] !== 'string') return null;
    safeApply(trustedSort, keys, []);
    return keys;
  };
  const bytesToHex = (bytes) => {
    const parts = [];
    for (let index = 0; index < bytes.length; index += 1) {
      const hex = safeApply(trustedNumberToString, bytes[index], [16]);
      parts[parts.length] = safeApply(trustedPadStart, hex, [2, '0']);
    }
    return safeApply(trustedJoin, parts, ['']);
  };
  const isPlainObject = (value) => {
    if (value === null || typeof value !== 'object') return false;
    const prototype = trustedGetPrototypeOf(value);
    return prototype === objectPrototype || prototype === null;
  };
  const isMessagePort = (value) => value !== null && typeof value === 'object' && trustedGetPrototypeOf(value) === messagePortPrototype;
  const exactKeys = (value, required) => {
    if (!isPlainObject(value)) return false;
    const keys = ownStringKeysSorted(value);
    if (!keys) return false;
    const expected = safeApply(trustedSlice, required, []);
    safeApply(trustedSort, expected, []);
    if (keys.length !== expected.length) return false;
    for (let index = 0; index < keys.length; index += 1) if (keys[index] !== expected[index]) return false;
    return true;
  };
  const safeJsonValue = (value, allowFunctions = false, seen = new trustedSet(), depth = 0, budget = {nodes: 0}) => {
    budget.nodes += 1;
    if (budget.nodes > 10000 || depth > 64) throw new Error('JSON_VALUE_LIMIT');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!trustedNumberIsFinite(value)) throw new Error('JSON_NUMBER_INVALID');
      return value;
    }
    if (typeof value === 'function' && allowFunctions) return '[function]';
    if (typeof value !== 'object') throw new Error('JSON_VALUE_INVALID');
    if (setHas(seen, value)) throw new Error('JSON_VALUE_CYCLE');
    setAdd(seen, value);
    if (trustedArrayIsArray(value)) {
      const ownKeys = safeApply(trustedOwnKeys, undefined, [value]);
      const lengthProperty = trustedGetOwnPropertyDescriptor(value, 'length');
      if (!lengthProperty || !hasOwn(lengthProperty, 'value') || !trustedNumberIsSafeInteger(lengthProperty.value) || lengthProperty.value < 0 || lengthProperty.value > 10000) throw new Error('JSON_ARRAY_INVALID');
      const length = lengthProperty.value;
      if (ownKeys.length !== length + 1) throw new Error('JSON_ARRAY_KEYS_INVALID');
      const expectedKeys = new trustedSet();
      setAdd(expectedKeys, 'length');
      const result = [];
      trustedSetPrototypeOf(result, null);
      for (let index = 0; index < length; index += 1) {
        const key = safeApply(trustedNumberToString, index, [10]);
        setAdd(expectedKeys, key);
        const property = trustedGetOwnPropertyDescriptor(value, key);
        if (!property || !hasOwn(property, 'value') || property.enumerable !== true) throw new Error('JSON_ARRAY_ACCESSOR_FORBIDDEN');
        trustedDefineProperty(result, key, {value: safeJsonValue(property.value, allowFunctions, seen, depth + 1, budget), enumerable: true, configurable: false, writable: false});
      }
      for (let index = 0; index < ownKeys.length; index += 1) if (typeof ownKeys[index] !== 'string' || !setHas(expectedKeys, ownKeys[index])) throw new Error('JSON_ARRAY_KEYS_INVALID');
      return result;
    }
    if (!isPlainObject(value)) throw new Error('JSON_VALUE_INVALID');
    const result = trustedCreate(null);
    const keys = ownStringKeysSorted(value);
    if (!keys) throw new Error('JSON_SYMBOL_KEY_FORBIDDEN');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const property = trustedGetOwnPropertyDescriptor(value, key);
      if (!property || !hasOwn(property, 'value') || property.enumerable !== true) throw new Error('JSON_ACCESSOR_FORBIDDEN');
      trustedDefineProperty(result, key, {value: safeJsonValue(property.value, allowFunctions, seen, depth + 1, budget), enumerable: true, configurable: false, writable: false});
    }
    return result;
  };
  const normalizedJsonBytes = (value) => byteLength(encode(safeApply(trustedStringify, JSON, [value])));
  const safeJsonBytes = (value, allowFunctions = false) => normalizedJsonBytes(safeJsonValue(value, allowFunctions));
  const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
  const allowedErrorCodes = new trustedSet();
  for (const code of ['APP_RUNTIME_FAILED', 'APP_BOOT_FAILED', 'APP_FACTORY_MISSING', 'APP_DUPLICATE_REGISTRATION', 'APP_REENTRANT_REGISTRATION', 'APP_ABI_INVALID', 'APP_ASYNC_FACTORY', 'APP_DESCRIPTOR_INVALID', 'APP_DESCRIPTOR_TOO_LARGE', 'APP_ASYNC_RETURN', 'CANDIDATE_U_TOP_LEVEL_EXCEPTION', 'PRELUDE_WASM_STARTUP_FAILED', 'SNAPSHOT_INVALID', 'SNAPSHOT_STATE_INVALID', 'EVENT_INVALID', 'RESULT_ID_INVALID', 'WORKER_MESSAGE_REPLAY', 'WORKER_MESSAGE_SCHEMA', 'WORKER_MESSAGE_TOO_LARGE', 'WORKER_MESSAGE_DESERIALIZATION_FAILED', 'WORKER_PROTOCOL_ERROR', 'TOO_MANY_PENDING']) setAdd(allowedErrorCodes, code);
  const errorCode = (value, fallback = 'APP_RUNTIME_FAILED') => {
    let candidate = '';
    try {
      const message = value !== null && (typeof value === 'object' || typeof value === 'function') ? trustedReflectGet(value, 'message') : value;
      if (typeof message === 'string') candidate = message;
    } catch (_) {}
    return safeApply(trustedRegExpTest, errorCodePattern, [candidate]) && setHas(allowedErrorCodes, candidate) ? candidate : fallback;
  };

  const sessionBytes = new Uint8Array(16);
  random(sessionBytes);
  const session = bytesToHex(sessionBytes);
  const workerSelfOrigin = self.origin;
  const workerLocationOrigin = location.origin;
  const workerLocationHref = location.href;
  const bootstrapKey = '__BOOTSTRAP_KEY_FROM_RENDERER__';
  const channelTestFixture = ${JSON.stringify(CHANNEL_TEST_FIXTURE)};
  let outgoingSequence = 0;
  let incomingSequence = 1;
  let registrationState = 'open';
  let descriptor;
  let privatePort;
  let bootstrapAccepted = false;
  let readySent = false;
  let terminal = false;
  let savedSnapshot;
  const pending = new trustedSet();

  const sendRaw = (type, body = {}) => {
    if (!privatePort) throw new Error('WORKER_CHANNEL_MISSING');
    const normalizedBody = safeJsonValue(body);
    const bodyKeys = ownStringKeysSorted(normalizedBody);
    if (!bodyKeys) throw new Error('WORKER_MESSAGE_SCHEMA');
    const nextSequence = outgoingSequence + 1;
    if (!trustedNumberIsSafeInteger(nextSequence)) throw new Error('WORKER_MESSAGE_REPLAY');
    const message = trustedCreate(null);
    const defineMessageProperty = (key, value) => trustedDefineProperty(message, key, {value, enumerable: true, configurable: false, writable: false});
    defineMessageProperty('channel', 'smallframe-prelude');
    defineMessageProperty('protocol', 1);
    defineMessageProperty('session', session);
    defineMessageProperty('sequence', nextSequence);
    defineMessageProperty('type', type);
    for (let index = 0; index < bodyKeys.length; index += 1) {
      const key = bodyKeys[index];
      if (key === 'channel' || key === 'protocol' || key === 'session' || key === 'sequence' || key === 'type') throw new Error('WORKER_MESSAGE_SCHEMA');
      const property = trustedGetOwnPropertyDescriptor(normalizedBody, key);
      if (!property || !hasOwn(property, 'value')) throw new Error('WORKER_MESSAGE_SCHEMA');
      defineMessageProperty(key, property.value);
    }
    if (normalizedJsonBytes(message) > 262144) throw new Error('WORKER_MESSAGE_TOO_LARGE');
    safeApply(trustedPortPostMessage, privatePort, [message]);
    outgoingSequence = nextSequence;
  };
  const closePrivatePort = () => {
    if (!privatePort) return;
    try { safeApply(trustedPortClose, privatePort, []); } catch (_) {}
  };
  const fail = (cause, fallback) => {
    if (terminal) return;
    terminal = true;
    try { sendRaw('error', {error: errorCode(cause, fallback)}); } catch (_) {}
    closePrivatePort();
  };
  const boundedId = () => {
    const bytes = new Uint8Array(16);
    random(bytes);
    return bytesToHex(bytes);
  };
  const deepFreeze = (value, seen = new trustedSet()) => {
    if (!value || typeof value !== 'object' || setHas(seen, value)) return value;
    setAdd(seen, value);
    const keys = trustedKeys(value);
    for (let index = 0; index < keys.length; index += 1) deepFreeze(value[keys[index]], seen);
    return trustedFreeze(value);
  };
  const isThenable = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try { return typeof trustedReflectGet(value, 'then') === 'function'; } catch (_) { return true; }
  };
  const validDescriptor = (candidate) => {
    if (!isPlainObject(candidate)) throw new Error('APP_ABI_INVALID');
    let encoded;
    try { encoded = safeJsonBytes(candidate, true); } catch (_) { throw new Error('APP_DESCRIPTOR_INVALID'); }
    if (encoded > 262144) throw new Error('APP_DESCRIPTOR_TOO_LARGE');
    const keys = ownStringKeysSorted(candidate);
    if (!keys) throw new Error('APP_ABI_INVALID');
    for (let index = 0; index < keys.length; index += 1) if (keys[index] !== 'onEvent' && keys[index] !== 'onResult' && keys[index] !== 'view') throw new Error('APP_ABI_INVALID');
    const viewProperty = trustedGetOwnPropertyDescriptor(candidate, 'view');
    const onEventProperty = trustedGetOwnPropertyDescriptor(candidate, 'onEvent');
    const onResultProperty = trustedGetOwnPropertyDescriptor(candidate, 'onResult');
    if (!viewProperty || !hasOwn(viewProperty, 'value') || typeof viewProperty.value !== 'function' || !onEventProperty || !hasOwn(onEventProperty, 'value') || typeof onEventProperty.value !== 'function') throw new Error('APP_ABI_INVALID');
    if (onResultProperty && !hasOwn(onResultProperty, 'value')) throw new Error('APP_ABI_INVALID');
    const onResult = onResultProperty ? onResultProperty.value : undefined;
    if (onResult !== undefined && typeof onResult !== 'function') throw new Error('APP_ABI_INVALID');
    const trustedDescriptor = trustedCreate(null);
    trustedDefineProperty(trustedDescriptor, 'view', {value: viewProperty.value, enumerable: true, configurable: false, writable: false});
    trustedDefineProperty(trustedDescriptor, 'onEvent', {value: onEventProperty.value, enumerable: true, configurable: false, writable: false});
    trustedDefineProperty(trustedDescriptor, 'onResult', {value: onResult, enumerable: true, configurable: false, writable: false});
    return trustedFreeze(trustedDescriptor);
  };
  const register = (factory) => {
    if (registrationState !== 'open') {
      if (registrationState === 'registering') registrationState = 'failed';
      throw new Error(registrationState === 'failed' ? 'APP_REENTRANT_REGISTRATION' : 'APP_DUPLICATE_REGISTRATION');
    }
    registrationState = 'registering';
    try {
      if (typeof factory !== 'function') throw new Error('APP_ABI_INVALID');
      const candidate = safeApply(factory, undefined, []);
      if (registrationState !== 'registering') throw new Error('APP_REENTRANT_REGISTRATION');
      if (isThenable(candidate)) throw new Error('APP_ASYNC_FACTORY');
      if (registrationState !== 'registering') throw new Error('APP_REENTRANT_REGISTRATION');
      descriptor = validDescriptor(candidate);
      if (registrationState !== 'registering') throw new Error('APP_REENTRANT_REGISTRATION');
      registrationState = 'registered';
    } catch (error) {
      registrationState = 'failed';
      throw error;
    }
  };
  const requestBatch = (operations) => {
    if (setSize(pending) >= 32) throw new Error('TOO_MANY_PENDING');
    const requestId = boundedId();
    setAdd(pending, requestId);
    sendRaw('state.batch', {requestId, operations});
    return requestId;
  };
  const freshContext = () => {
    if (!savedSnapshot) throw new Error('SNAPSHOT_MISSING');
    const state = safeJsonValue(savedSnapshot.state);
    if (!isPlainObject(state)) throw new Error('SNAPSHOT_STATE_INVALID');
    trustedDefineProperty(state, 'batch', {value: requestBatch, enumerable: false, writable: false, configurable: false});
    return deepFreeze({state: deepFreeze(state), role: savedSnapshot.role, online: savedSnapshot.online, revision: savedSnapshot.revision, randomId: boundedId, now: () => trustedMathFloor(trustedDateNow() / 1000)});
  };
  const renderTree = (tree) => sendRaw('render', {tree});
  const renderSnapshot = (message) => {
    if (!isPlainObject(message.state) || (message.role !== 'editor' && message.role !== 'viewer') || typeof message.online !== 'boolean' || !trustedNumberIsSafeInteger(message.revision) || message.revision < 0) throw new Error('SNAPSHOT_INVALID');
    savedSnapshot = deepFreeze({state: safeJsonValue(message.state), role: message.role, online: message.online, revision: message.revision});
    const result = safeApply(descriptor.view, undefined, [freshContext()]);
    if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    renderTree(result);
  };
  const renderEvent = (message) => {
    if (!isPlainObject(message.event)) throw new Error('EVENT_INVALID');
    const before = setSize(pending);
    const result = safeApply(descriptor.onEvent, undefined, [message.event, freshContext()]);
    if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    if (setSize(pending) === before) {
      const tree = safeApply(descriptor.view, undefined, [freshContext()]);
      if (isThenable(tree)) throw new Error('APP_ASYNC_RETURN');
      renderTree(tree);
    }
  };
  const renderResult = (message) => {
    if (!isPlainObject(message.result) || typeof message.result.requestId !== 'string' || !setHas(pending, message.result.requestId)) throw new Error('RESULT_ID_INVALID');
    setDelete(pending, message.result.requestId);
    if (typeof descriptor.onResult === 'function') {
      const result = safeApply(descriptor.onResult, undefined, [safeJsonValue(message.result), freshContext()]);
      if (isThenable(result)) throw new Error('APP_ASYNC_RETURN');
    }
    const tree = safeApply(descriptor.view, undefined, [freshContext()]);
    if (isThenable(tree)) throw new Error('APP_ASYNC_RETURN');
    renderTree(tree);
  };
  const onPrivateMessage = (event) => {
    if (terminal || !readySent) return;
    let message;
    try {
      const ports = safeApply(messagePortsGetter, event, []);
      if (!ports || ports.length !== 0) throw new Error('WORKER_MESSAGE_SCHEMA');
      message = safeJsonValue(safeApply(messageDataGetter, event, []));
      if (normalizedJsonBytes(message) > 262144) throw new Error('WORKER_MESSAGE_TOO_LARGE');
    } catch (error) { fail(error, 'WORKER_MESSAGE_SCHEMA'); return; }
    if (!isPlainObject(message) || message.channel !== 'smallframe-controller' || message.protocol !== 1 || message.session !== session || !trustedNumberIsSafeInteger(message.sequence) || message.sequence !== incomingSequence) { fail('WORKER_MESSAGE_REPLAY', 'WORKER_MESSAGE_REPLAY'); return; }
    incomingSequence += 1;
    try {
      if (message.type === 'snapshot' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'state', 'role', 'online', 'revision'])) renderSnapshot(message);
      else if (message.type === 'event' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'event'])) renderEvent(message);
      else if (message.type === 'result' && exactKeys(message, ['channel', 'protocol', 'session', 'sequence', 'type', 'result'])) renderResult(message);
      else throw new Error('WORKER_MESSAGE_SCHEMA');
    } catch (error) { fail(error, 'WORKER_PROTOCOL_ERROR'); }
  };
  const onPrivateMessageError = () => fail('WORKER_MESSAGE_DESERIALIZATION_FAILED', 'WORKER_MESSAGE_DESERIALIZATION_FAILED');
  const runPublisher = () => {
    if (terminal) return;
    try {
      if (!phase0WasmStarted) throw new Error('PRELUDE_WASM_STARTUP_FAILED');
      safeApply(__smallframePublisherEntry, undefined, [register]);
      if (registrationState !== 'registered') throw new Error('APP_FACTORY_MISSING');
      registrationState = 'sealed';
      readySent = true;
      sendRaw('prelude-ready', {workerKind: 'classic-blob', blobCount: 1, dynamicImport: false, importScripts: false, workerSelfOrigin, workerLocationOrigin, workerLocationHref, wasmStarted: true, wasmBytes: phase0WasmBytes, wasmProbe: phase0WasmProbe, wasmDigest: phase0WasmDigest});
      if (channelTestFixture === 'worker-outbound-replay') {
        const replay = {channel: 'smallframe-prelude', protocol: 1, session, sequence: outgoingSequence, type: 'render', tree: {text: 'replayed'}};
        safeApply(trustedPortPostMessage, privatePort, [replay]);
      }
      else if (channelTestFixture === 'worker-outbound-nonobject') safeApply(trustedPortPostMessage, privatePort, [null]);
    } catch (error) { fail(error, 'APP_BOOT_FAILED'); }
  };
  const bootstrapMessage = (event) => {
    try { safeApply(trustedStopImmediatePropagation, event, []); } catch (_) {}
    if (bootstrapAccepted || !eventIsTrusted(event)) return;
    const data = safeApply(messageDataGetter, event, []);
    const ports = safeApply(messagePortsGetter, event, []);
    if (!exactKeys(data, ['channel', 'protocol', 'type', 'key']) || data.channel !== 'smallframe-bootstrap' || data.protocol !== 1 || data.type !== 'attach' || data.key !== bootstrapKey || !ports || ports.length !== 1 || !isMessagePort(ports[0])) return;
    bootstrapAccepted = true;
    safeApply(trustedGlobalRemoveEventListener, self, ['message', bootstrapMessage, true]);
    privatePort = ports[0];
    safeApply(trustedPortAddEventListener, privatePort, ['message', onPrivateMessage]);
    safeApply(trustedPortAddEventListener, privatePort, ['messageerror', onPrivateMessageError]);
    safeApply(trustedPortStart, privatePort, []);
    runPublisher();
  };

  const deny = (name) => () => { throw new Error(name + '_DENIED'); };
  safeApply(trustedGlobalAddEventListener, self, ['message', bootstrapMessage, true]);
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'WebTransport', 'XMLHttpRequest', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel']) {
    try { trustedDefineProperty(globalThis, name, {value: deny(name), configurable: false, writable: false}); } catch (_) {}
  }
  try { trustedDefineProperty(globalThis, 'postMessage', {value: deny('publisher.postMessage'), configurable: false, writable: false}); } catch (_) {}
  try { trustedDefineProperty(globalThis, 'indexedDB', {value: trustedFreeze({open: deny('indexedDB')}), configurable: false, writable: false}); } catch (_) {}
  try { trustedDefineProperty(globalThis, 'caches', {value: trustedFreeze({open: deny('caches')}), configurable: false, writable: false}); } catch (_) {}
})();
`;

const revokeClassicWorkerUrl = (): void => {
  if (classicWorkerBlobUrl) URL.revokeObjectURL(classicWorkerBlobUrl);
  classicWorkerBlobUrl = '';
};

const teardownClassicWorker = (): void => {
  classicWorkerReady = false;
  classicWorkerSession = '';
  classicWorkerBootstrapKey = '';
  window.clearTimeout(classicWorkerReadyTimer);
  window.clearTimeout(classicWorkerBusyTimer);
  revokeClassicWorkerUrl();
  classicWorkerPort?.close();
  classicWorkerPort = undefined;
  worker?.terminate();
  worker = undefined;
};

const publishWorkerLifecycle = (state: 'booting' | 'running' | 'restarting' | 'stopped', stopCode = ''): void => {
  sendParent('sf.renderer.worker-lifecycle', {
    state,
    generation: classicWorkerGeneration,
    restartCount: classicWorkerRestartCount,
    lastReason: classicWorkerLastReason,
    ...(stopCode ? {stopCode} : {})
  });
};

const stopClassicWorker = (reason: string): void => {
  if (IS_CANDIDATE_U && classicWorkerTerminal) return;
  classicWorkerTerminal = true;
  classicWorkerRestarting = false;
  classicWorkerLastReason = reason;
  teardownClassicWorker();
  if (IS_CANDIDATE_U) publishWorkerLifecycle('stopped', reason);
  sendParent('sf.renderer.error', {error: reason, generation: classicWorkerGeneration, restartCount: classicWorkerRestartCount});
};

const restartClassicWorker = (reason: string): void => {
  if (!USES_CLASSIC_WORKER || classicWorkerRestarting || classicWorkerTerminal) return;
  if (IS_CANDIDATE_U && reason !== 'WORKER_WATCHDOG_TIMEOUT') { stopClassicWorker(reason); return; }
  if (IS_CANDIDATE_U && classicWorkerRestartCount >= 1) { stopClassicWorker('WORKER_RESTART_BUDGET_EXHAUSTED'); return; }
  classicWorkerRestarting = true;
  if (IS_CANDIDATE_U) {
    classicWorkerRestartCount += 1;
    classicWorkerLastReason = reason;
  }
  teardownClassicWorker();
  if (IS_CANDIDATE_U) publishWorkerLifecycle('restarting');
  else sendParent('sf.renderer.error', {error: reason});
  window.setTimeout(() => {
    classicWorkerRestarting = false;
    bootApp('');
  }, 0);
};

const bootApp = (appModule: string): void => {
  if (USES_CLASSIC_WORKER) {
    if (IS_CANDIDATE_U && classicWorkerTerminal) return;
    classicWorkerGeneration += 1;
    if (IS_CANDIDATE_U) publishWorkerLifecycle('booting');
    classicWorkerPayload = classicWorkerPayload || (IS_CANDIDATE_U ? candidateUBlobWorkerSource(preparedModuleSource || CANDIDATE_FACTORY_SOURCE) : classicBlobWorkerSource());
    classicWorkerOutgoingSequence = 0;
    classicWorkerIncomingSequence = 1;
    classicWorkerReady = false;
    classicWorkerSession = '';
    classicWorkerBootstrapKey = randomBase64Url(32);
    const payload = classicWorkerPayload.replaceAll("'__BOOTSTRAP_KEY_FROM_RENDERER__'", JSON.stringify(classicWorkerBootstrapKey));
    if (payload === classicWorkerPayload) { IS_CANDIDATE_U ? stopClassicWorker('WORKER_BOOTSTRAP_KEY_MISSING') : restartClassicWorker('WORKER_BOOTSTRAP_KEY_MISSING'); return; }
    classicWorkerBlobUrl = URL.createObjectURL(new Blob([payload], {type: 'text/javascript'}));
    worker = new Worker(workerScriptUrl(classicWorkerBlobUrl), {name: 'smallframe-app'});
    const channel = new MessageChannel();
    classicWorkerPort = channel.port1;
    classicWorkerPort.onmessage = (event: MessageEvent) => {
      if (event.ports.length !== 0) { if (IS_CANDIDATE_U) stopClassicWorker('WORKER_TRANSFER_FORBIDDEN'); return; }
      const raw = event.data;
      const messageSize = safeSizeOf(raw);
      if (!isPlainRecord(raw) || messageSize > MAX_MESSAGE_BYTES) {
        if (IS_CANDIDATE_U) stopClassicWorker('WORKER_PROTOCOL_ENVELOPE_INVALID');
        return;
      }
      const message = raw as {channel?: unknown; protocol?: unknown; session?: unknown; sequence?: unknown; type?: string; tree?: unknown; error?: string; requestId?: string; operations?: unknown; workerKind?: string; blobCount?: number; dynamicImport?: boolean; importScripts?: boolean; workerSelfOrigin?: string; workerLocationOrigin?: string; workerLocationHref?: string; wasmStarted?: boolean; wasmBytes?: number; wasmProbe?: number; wasmDigest?: string};
      if (message.channel !== 'smallframe-prelude' || message.protocol !== 1 || typeof message.session !== 'string' || message.sequence !== classicWorkerIncomingSequence || !Number.isSafeInteger(message.sequence)) {
        if (IS_CANDIDATE_U) stopClassicWorker('WORKER_PROTOCOL_ENVELOPE_INVALID');
        return;
      }
      try {
      if (message.type === 'prelude-ready') {
        const readyKeys = Object.keys(message).sort().join(',');
        const expectedReadyKeys = (IS_CANDIDATE_U ? 'blobCount,channel,dynamicImport,importScripts,protocol,sequence,session,type,workerLocationHref,workerLocationOrigin,workerSelfOrigin,workerKind,wasmBytes,wasmDigest,wasmProbe,wasmStarted' : 'blobCount,channel,dynamicImport,importScripts,protocol,sequence,session,type,workerLocationHref,workerLocationOrigin,workerSelfOrigin,workerKind').split(',').sort().join(',');
        if ((IS_CANDIDATE_U && (classicWorkerReady || readyKeys !== expectedReadyKeys || message.wasmStarted !== true || message.wasmBytes !== PHASE0_WASM_BYTES || message.wasmProbe !== 0xf88bbfb9 || message.wasmDigest !== PHASE0_WASM_SHA256)) || message.workerKind !== 'classic-blob' || message.blobCount !== 1 || message.dynamicImport !== false || message.importScripts !== false || ((ARCHITECTURE_CANDIDATE === 'T' || IS_CANDIDATE_U) && (message.workerSelfOrigin !== 'null' || message.workerLocationOrigin !== 'null' || typeof message.workerLocationHref !== 'string' || !message.workerLocationHref.startsWith('blob:null/')))) { IS_CANDIDATE_U ? stopClassicWorker('WORKER_ATTESTATION_INVALID') : restartClassicWorker('WORKER_ATTESTATION_INVALID'); return; }
        classicWorkerSession = message.session;
        classicWorkerReady = true;
        window.clearTimeout(classicWorkerReadyTimer);
        revokeClassicWorkerUrl();
        sendClassicWorker('snapshot', {state: currentState, role: 'editor', online: navigator.onLine, revision: 0});
        if (IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'worker-inbound-replay' && classicWorkerPort) {
          classicWorkerPort.postMessage({channel: 'smallframe-controller', protocol: 1, session: classicWorkerSession, sequence: classicWorkerOutgoingSequence, type: 'snapshot', state: currentState, role: 'editor', online: navigator.onLine, revision: 0});
        }
        if (IS_CANDIDATE_U) publishWorkerLifecycle('running');
        sendParent('sf.renderer.app-ready', {workerKind: 'classic-blob', blobCount: 1, workerSelfOrigin: message.workerSelfOrigin, workerLocationOrigin: message.workerLocationOrigin, workerLocationHref: message.workerLocationHref, wasmStarted: message.wasmStarted, wasmBytes: message.wasmBytes, wasmProbe: message.wasmProbe, wasmDigest: message.wasmDigest, generation: classicWorkerGeneration, restartCount: classicWorkerRestartCount, lastReason: classicWorkerLastReason, ...(IS_CANDIDATE_U ? {verifierStarted: phase1VerifierStarted, verifierBytes: PHASE1_WASM_BYTES, verifierVersion: phase1Verifier?.wasm_verifier_version() ?? 0, verifierDigest: PHASE1_WASM_SHA256} : {})});
      } else if (message.type === 'error') {
        if (IS_CANDIDATE_U && (Object.keys(message).sort().join(',') !== 'channel,error,protocol,sequence,session,type' || typeof message.error !== 'string' || (classicWorkerReady && message.session !== classicWorkerSession))) { stopClassicWorker('WORKER_MESSAGE_SCHEMA'); return; }
        IS_CANDIDATE_U ? stopClassicWorker(message.error ?? 'WORKER_ERROR') : restartClassicWorker(message.error ?? 'WORKER_ERROR');
        return;
      } else if (message.session !== classicWorkerSession || !classicWorkerReady) {
        if (IS_CANDIDATE_U) { stopClassicWorker('WORKER_SESSION_INVALID'); return; }
      }
      else if (message.type === 'render') {
        if (IS_CANDIDATE_U && Object.keys(message).sort().join(',') !== 'channel,protocol,sequence,session,tree,type') { stopClassicWorker('WORKER_MESSAGE_SCHEMA'); return; }
        displayTree(message.tree);
      }
      else if (message.type === 'state.batch') {
        if (IS_CANDIDATE_U && (Object.keys(message).sort().join(',') !== 'channel,operations,protocol,requestId,sequence,session,type' || typeof message.requestId !== 'string')) { stopClassicWorker('WORKER_MESSAGE_SCHEMA'); return; }
        sendParent('sf.renderer.state.batch', {requestId: message.requestId, operations: message.operations});
      }
      else if (IS_CANDIDATE_U) { stopClassicWorker('WORKER_MESSAGE_SCHEMA'); return; }
      classicWorkerIncomingSequence += 1;
      } catch (_) {
        if (IS_CANDIDATE_U) stopClassicWorker('WORKER_DISPATCH_FAILED');
      }
    };
    classicWorkerPort.onmessageerror = () => { if (IS_CANDIDATE_U) stopClassicWorker('WORKER_MESSAGE_DESERIALIZATION_FAILED'); };
    classicWorkerPort.start();
    worker.onmessage = () => { if (IS_CANDIDATE_U) stopClassicWorker('WORKER_GLOBAL_MESSAGE_FORBIDDEN'); };
    worker.onmessageerror = () => { if (IS_CANDIDATE_U) stopClassicWorker('WORKER_GLOBAL_MESSAGE_INVALID'); };
    worker.onerror = (event) => { event.preventDefault(); IS_CANDIDATE_U ? stopClassicWorker('WORKER_SOURCE_ERROR') : restartClassicWorker('WORKER_TERMINATED'); };
    worker.postMessage({channel: 'smallframe-bootstrap', protocol: 1, type: 'attach', key: classicWorkerBootstrapKey}, [channel.port2]);
    classicWorkerReadyTimer = window.setTimeout(() => IS_CANDIDATE_U ? stopClassicWorker('WORKER_READY_TIMEOUT') : restartClassicWorker('WORKER_READY_TIMEOUT'), 2000);
    return;
  }
  const appUrl = URL.createObjectURL(new Blob([appModule], {type: 'text/javascript'}));
  const bootstrapUrl = URL.createObjectURL(new Blob([appBootstrap(appUrl)], {type: 'text/javascript'}));
  worker = new Worker(workerScriptUrl(bootstrapUrl), {type: 'module', name: 'smallframe-app'});
  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as {protocol?: unknown; type?: string; tree?: unknown; error?: string; requestId?: string; operations?: unknown};
    if (message.protocol !== 1) { sendParent('sf.renderer.error', {error: 'WORKER_PROTOCOL_INVALID'}); return; }
    if (message.type === 'ready') { sendWorker('snapshot', {state: currentState, role: 'editor', online: navigator.onLine, revision: 0}); sendParent('sf.renderer.app-ready'); }
    else if (message.type === 'render') displayTree(message.tree);
    else if (message.type === 'state.batch') sendParent('sf.renderer.state.batch', {requestId: message.requestId, operations: message.operations});
    else if (message.type === 'error') sendParent('sf.renderer.error', {error: message.error ?? 'WORKER_ERROR'});
  };
  worker.onerror = () => sendParent('sf.renderer.error', {error: 'WORKER_TERMINATED'});
  queueMicrotask(() => { URL.revokeObjectURL(appUrl); URL.revokeObjectURL(bootstrapUrl); });
};

const terminateParentChannel = (reason: string): void => {
  if (parentChannelTerminal) return;
  if (IS_CANDIDATE_U && !classicWorkerTerminal) stopClassicWorker(reason);
  else sendParent('sf.renderer.error', {error: reason});
  parentChannelTerminal = true;
  port?.close();
  port = undefined;
};

type ControllerMessage = PortMessage & {state?: unknown; role?: unknown; online?: unknown; revision?: unknown; result?: unknown};
const acceptSnapshot = (message: ControllerMessage, baseKeys: string[]): void => {
  if (!exactKeys(message, [...baseKeys, 'state', 'role', 'online', 'revision']) || !isPlainRecord(message.state) || (message.role !== 'editor' && message.role !== 'viewer') || typeof message.online !== 'boolean' || !Number.isSafeInteger(message.revision) || Number(message.revision) < 0) { terminateParentChannel('CHANNEL_MESSAGE_SCHEMA'); return; }
  try {
    const nextState = structuredClone(message.state);
    sendWorker('snapshot', {state: nextState, role: message.role, online: message.online, revision: message.revision});
    currentState = nextState;
    incomingSequence += 1;
  } catch (_) { terminateParentChannel('CHANNEL_DISPATCH_FAILED'); }
};
const acceptApproval = (message: ControllerMessage, baseKeys: string[]): void => {
  if (!packageApprovalPending || !exactKeys(message, [...baseKeys, 'state', 'role']) || !isPlainRecord(message.state) || (message.role !== 'editor' && message.role !== 'viewer')) { terminateParentChannel('CHANNEL_MESSAGE_SCHEMA'); return; }
  try {
    currentState = structuredClone(message.state);
    packageApprovalPending = false;
    incomingSequence += 1;
    bootApp('');
  } catch (_) { terminateParentChannel('CHANNEL_DISPATCH_FAILED'); }
};

const onPortMessage = (event: MessageEvent): void => {
  if (parentChannelTerminal) return;
  if (event.ports.length !== 0) { terminateParentChannel('CHANNEL_TRANSFER_FORBIDDEN'); return; }
  const raw = event.data;
  const messageBytes = safeSizeOf(raw);
  if (messageBytes > MAX_MESSAGE_BYTES) { terminateParentChannel('CHANNEL_MESSAGE_TOO_LARGE'); return; }
  if (!isPlainRecord(raw)) { terminateParentChannel('CHANNEL_ENVELOPE_INVALID'); return; }
  const message = raw as ControllerMessage;
  if (message.channel !== 'smallframe-controller' || message.protocol !== 1 || typeof message.type !== 'string' || !Number.isSafeInteger(message.sequence)) { terminateParentChannel('CHANNEL_ENVELOPE_INVALID'); return; }
  if (message.session !== sessionId) { terminateParentChannel('CHANNEL_SESSION_INVALID'); return; }
  if (message.sequence !== incomingSequence) { terminateParentChannel('CHANNEL_SEQUENCE_REPLAY'); return; }
  const baseKeys = ['channel', 'protocol', 'session', 'sequence', 'type'];
  if (message.type === 'sf.controller.snapshot') acceptSnapshot(message, baseKeys);
  else if (message.type === 'sf.controller.result') {
    if (!exactKeys(message, [...baseKeys, 'result']) || !isPlainRecord(message.result)) { terminateParentChannel('CHANNEL_MESSAGE_SCHEMA'); return; }
    try {
      sendWorker('result', USES_CLASSIC_WORKER ? {result: message.result} : {result: message.result, state: currentState, role: 'editor', online: navigator.onLine, revision: 0});
      incomingSequence += 1;
    } catch (_) { terminateParentChannel('CHANNEL_DISPATCH_FAILED'); }
  }
  else if (message.type === 'sf.controller.approval') acceptApproval(message, baseKeys);
  else terminateParentChannel('CHANNEL_MESSAGE_SCHEMA');
};

const validInitEvent = (event: MessageEvent, transferredPort: MessagePort | undefined, challenge: unknown, initKeys: string[]): boolean => {
  if (event.source !== window.parent || event.origin !== CONTROLLER_ORIGIN) return false;
  if (!isPlainRecord(event.data) || event.data.type !== 'sf.renderer.init' || event.data.protocol !== 1 || challenge !== nonce) return false;
  if (!transferredPort) return false;
  if (!IS_CANDIDATE_U) return true;
  if (!exactKeys(event.data, initKeys) || event.ports.length !== 1 || !(transferredPort instanceof MessagePort)) return false;
  if (safeSizeOf(event.data) > MAX_MESSAGE_BYTES || typeof event.data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(event.data.sessionId)) return false;
  return isPlainRecord(event.data.state) && (event.data.role === 'editor' || event.data.role === 'viewer');
};

const acceptPreparedPackage = (data: Record<string, unknown>): void => {
  if (!(data.packageBytes instanceof Uint8Array) || data.packageBytes.byteLength > 1_310_720 || typeof data.expectedPackageDigest !== 'string' || typeof data.expectedPublisherKeyId !== 'string') throw new Error('PACKAGE_INIT_INVALID');
  const prepared = preparePhase2Package(data.packageBytes, data.expectedPackageDigest, data.expectedPublisherKeyId);
  const manifest = prepared.manifest;
  const publisher = manifest.publisher;
  const state = manifest.state;
  if (!isPlainRecord(publisher) || !isPlainRecord(state)) throw new Error('PACKAGE_MANIFEST_RUNTIME_INVALID');
  const textFields = [manifest.name, manifest.version, manifest.description, publisher.displayName, publisher.publicKey];
  if (!textFields.every((value) => typeof value === 'string') || publisher.keyId !== prepared.publisherKeyId) throw new Error('PACKAGE_MANIFEST_RUNTIME_INVALID');
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.every((value) => typeof value === 'string')) throw new Error('PACKAGE_MANIFEST_RUNTIME_INVALID');
  if (!isPlainRecord(state.publicTemplate ?? {}) || !Number.isSafeInteger(state.maxPlaintextBytes) || (state.mode !== 'personal' && state.mode !== 'shared')) throw new Error('PACKAGE_MANIFEST_RUNTIME_INVALID');
  preparedModuleSource = prepared.moduleSource;
  packageApprovalPending = true;
  sendParent('sf.renderer.package-verified', {packageDigest: prepared.packageDigest, artifactDigest: prepared.artifactDigest, publisherKeyId: prepared.publisherKeyId, publisherPublicKey: publisher.publicKey, publisherDisplayName: publisher.displayName, appName: manifest.name, appVersion: manifest.version, description: manifest.description, capabilities: manifest.capabilities, publicTemplate: state.publicTemplate ?? {}, maxPlaintextBytes: state.maxPlaintextBytes, declaredMode: state.mode});
};

const receiveInit = (event: MessageEvent): void => {
  if (initAccepted) return;
  const transferredPort = event.ports[0];
  const challenge = ARCHITECTURE_CANDIDATE === 'A' ? event.data?.challenge : event.data?.nonce;
  const hasPackage = IS_CANDIDATE_U && Object.prototype.hasOwnProperty.call(event.data ?? {}, 'packageBytes');
  const packageKeys = hasPackage ? ['packageBytes', 'expectedPackageDigest', 'expectedPublisherKeyId'] : [];
  const initKeys = ARCHITECTURE_CANDIDATE === 'A' ? ['type', 'protocol', 'challenge', 'sessionId', ...(USES_CLASSIC_WORKER ? [] : ['appModule']), 'state', 'role', ...packageKeys] : ['type', 'protocol', 'nonce', 'sessionId', ...(USES_CLASSIC_WORKER ? [] : ['appModule']), 'state', 'role', ...packageKeys];
  if (!validInitEvent(event, transferredPort, challenge, initKeys)) return;
  if (!transferredPort) return;
  initAccepted = true;
  window.removeEventListener('message', receiveInit);
  port = transferredPort;
  port.onmessage = onPortMessage;
  port.onmessageerror = () => terminateParentChannel('CHANNEL_MESSAGE_DESERIALIZATION_FAILED');
  sessionId = String(event.data.sessionId ?? '');
  if (!sessionId || (!USES_CLASSIC_WORKER && typeof event.data.appModule !== 'string')) { sendParent('sf.renderer.error', {error: 'INIT_INVALID'}); return; }
  currentState = structuredClone(event.data.state ?? {});
  outgoingSequence = 0;
  incomingSequence = 1;
  parentChannelTerminal = false;
  rendererChannelFixtureInjected = false;
  classicWorkerGeneration = 0;
  classicWorkerRestartCount = 0;
  classicWorkerLastReason = '';
  classicWorkerTerminal = false;
  preparedModuleSource = '';
  packageApprovalPending = false;
  nonce = '';
  port.start();
  if (hasPackage) {
    try {
      acceptPreparedPackage(event.data as Record<string, unknown>);
    } catch (error) { terminateParentChannel(error instanceof Error ? error.message : 'PACKAGE_VERIFY_FAILED'); }
    return;
  }
  bootApp(typeof event.data.appModule === 'string' ? event.data.appModule : '');
};

if (IS_CANDIDATE_U) {
  phase1VerifierStarted = startPhase1Verifier();
  if (!phase1VerifierStarted) throw new Error('PHASE1_VERIFIER_STARTUP_FAILED');
}
if (ARCHITECTURE_CANDIDATE === 'A') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  nonce = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
} else {
  const fragment = window.location.hash.slice(1);
  try { nonce = fragment; } finally { history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`); }
}
window.addEventListener('message', receiveInit);
const readyMessage = {type: 'sf.renderer.ready', protocol: 1, ...(ARCHITECTURE_CANDIDATE === 'A' ? {challenge: nonce} : {nonce}), ...(IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'ready-schema-extra' ? {unexpected: true} : {})};
if (IS_CANDIDATE_U && CHANNEL_TEST_FIXTURE === 'ready-port') {
  const readyChannel = new MessageChannel();
  window.parent.postMessage(readyMessage, CONTROLLER_ORIGIN, [readyChannel.port2]);
  window.setTimeout(() => readyChannel.port1.close(), 1000);
} else window.parent.postMessage(readyMessage, CONTROLLER_ORIGIN);
