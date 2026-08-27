(() => {
  const fixture = '__SMALLFRAME_T_FIXTURE__';
  if (fixture === 'top-level') while (true) {}
  if (fixture === 'exception') throw new Error('CANDIDATE_T_TOP_LEVEL_EXCEPTION');
  const register = globalThis.__smallframe_register;
  const h = (tag, props = {}, children = []) => ({
    tag,
    ...(props.key ? {key: props.key} : {}),
    ...(props.class ? {class: props.class} : {}),
    ...(props.on ? {on: props.on} : {}),
    ...(Object.keys(props).some((key) => !['key', 'class', 'on', 'children'].includes(key))
      ? {props: Object.fromEntries(Object.entries(props).filter(([key]) => !['key', 'class', 'on', 'children'].includes(key)))}
      : {}),
    children
  });
  const text = (value) => ({text: String(value)});
  const defineApp = (descriptor) => descriptor;
  const forgeGlobal = (message) => {
    let cursor = globalThis;
    for (let depth = 0; cursor && depth < 8; depth += 1) {
      const candidate = Object.getOwnPropertyDescriptor(cursor, 'postMessage')?.value;
      if (typeof candidate === 'function' && candidate !== globalThis.postMessage) {
        try { Reflect.apply(candidate, globalThis, [message]); } catch (_) {}
        return;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  };

  // These attempts are intentionally part of the checked-in hostile fixture.
  // Candidate T must deny or contain them before they can cross the boundary.
  try { fetch('http://localhost:8790/canary?source=candidate-t-factory'); } catch (_) {}
  try { new WebSocket('ws://localhost:8791/canary'); } catch (_) {}
  try { new Worker('data:text/javascript,'); } catch (_) {}
  try { new SharedWorker('data:text/javascript,'); } catch (_) {}
  try { importScripts('data:text/javascript,'); } catch (_) {}
  try { indexedDB.open('__smallframe_candidate_t__'); } catch (_) {}
  try { caches.open('__smallframe_candidate_t__'); } catch (_) {}
  try { navigator.serviceWorker?.getRegistration(); } catch (_) {}
  try { new BroadcastChannel('__smallframe_candidate_t__'); } catch (_) {}
  try { if (typeof document !== 'undefined') throw new Error('DOM_VISIBLE'); } catch (_) {}

  // A publisher can recover a native WorkerGlobalScope.postMessage and can
  // dispatch fake events, but neither can reach the private MessagePort.
  forgeGlobal({channel: 'smallframe-prelude', protocol: 1, session: 'forged', sequence: 1, type: 'prelude-ready'});
  forgeGlobal({channel: 'smallframe-prelude', protocol: 1, session: 'forged', sequence: 1, type: 'render', tree: {text: 'forged'}});
  forgeGlobal({channel: 'smallframe-prelude', protocol: 1, session: 'forged', sequence: 1, type: 'state.batch', requestId: 'forged', operations: []});
  forgeGlobal({channel: 'smallframe-prelude', protocol: 1, session: 'forged', sequence: 1, type: 'error', error: 'forged'});
  try { self.addEventListener('message', () => {}); } catch (_) {}
  try {
    const fake = new MessageChannel();
    self.dispatchEvent(new MessageEvent('message', {data: {channel: 'smallframe-bootstrap', protocol: 1, type: 'attach', key: 'forged'}, ports: [fake.port1]}));
    fake.port1.close();
    fake.port2.close();
  } catch (_) {}
  try { Object.defineProperty(MessagePort.prototype, 'postMessage', {value: () => { throw new Error('publisher-port-poison'); }}); } catch (_) {}
  try { Object.defineProperty(MessageEvent.prototype, 'isTrusted', {get: () => false}); } catch (_) {}

  const validDescriptor = {
    view({state, role, online}) {
      const count = Object.keys(state.decisions ?? {}).length;
      return h('section', {class: ['sf-stack']}, [
        h('p', {}, [text('Role: ' + role + ' · ' + (online ? 'Online' : 'Offline'))]),
        h('p', {class: ['sf-emphasis']}, [text('Decisions: ' + count)]),
        h('button', {key: 'add', on: {click: 'add'}}, [text('Add decision')]),
        h('button', {key: 'watchdog', on: {click: 'watchdog'}}, [text('Run bounded watchdog fixture')])
      ]);
    },
    onEvent(event, context) {
      if (event.action === 'add') {
        context.state.batch([{op: 'set', path: ['decisions', context.randomId()], value: {title: 'Untitled'}}]);
      }
      if (event.action === 'watchdog') {
        while (true) {}
      }
    }
  };
  if (fixture === 'missing') return;
  if (fixture === 'thenable') { register(() => ({then: () => {}})); return; }
  if (fixture === 'malformed') { register(() => ({view: validDescriptor.view})); return; }
  if (fixture === 'oversized') { register(() => ({view: validDescriptor.view, onEvent: validDescriptor.onEvent, payload: 'x'.repeat(300000)})); return; }
  register(() => defineApp(validDescriptor));
  if (fixture === 'duplicate') register(() => defineApp(validDescriptor));
})();
