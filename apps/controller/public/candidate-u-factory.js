(() => {
  'use strict';

  const fixture = '__SMALLFRAME_U_FIXTURE__';
  const htmlParserBreakoutProbe = '</script><script>globalThis.__smallframePublisherReachedDom = true</script>';
  void htmlParserBreakoutProbe;
  if (fixture === 'top-level') while (true) {}
  if (fixture === 'exception') throw new Error('CANDIDATE_U_TOP_LEVEL_EXCEPTION');

  const register = __smallframeRegister;
  const publisherObjectKeys = Object.keys;
  const h = (tag, props = {}, children = []) => ({
    tag,
    ...(props.key ? {key: props.key} : {}),
    ...(props.class ? {class: props.class} : {}),
    ...(props.on ? {on: props.on} : {}),
    ...(publisherObjectKeys(props).some((key) => !['key', 'class', 'on', 'children'].includes(key))
      ? {props: Object.fromEntries(Object.entries(props).filter(([key]) => !['key', 'class', 'on', 'children'].includes(key)))}
      : {}),
    children
  });
  const text = (value) => ({text: String(value)});
  const defineApp = (descriptorValue) => descriptorValue;
  const isReferenceError = (attempt) => {
    try {
      attempt();
      return false;
    } catch (error) {
      return error instanceof ReferenceError;
    }
  };

  // These are literal lexical reads. They intentionally do not use eval,
  // Function, identifier mangling, or typeof, and they never render values.
  // If publisher source is accidentally nested in the trusted prelude again,
  // at least one probe becomes visible and the fixture reports a breach.
  const lexicalProbes = [
    () => session,
    () => privatePort,
    () => savedSnapshot,
    () => pending,
    () => send('render', {tree: {text: 'LEXICAL_AUTHORITY_LEAK'}}),
    () => bootstrapKey,
    () => outgoingSequence,
    () => incomingSequence,
    () => descriptor,
    () => safeApply,
    () => trustedPortPostMessage,
    () => trustedStringify,
    () => trustedNumberIsSafeInteger,
    () => trustedDateNow,
    () => trustedSetHas
  ];
  const isolatedCount = lexicalProbes.filter(isReferenceError).length;
  const lexicalIsolation = isolatedCount === lexicalProbes.length;

  const denied = (attempt) => {
    try {
      attempt();
      return false;
    } catch (_) {
      return true;
    }
  };
  const authorityProbes = [
    denied(() => fetch('http://127.0.0.1:8790/canary?source=candidate-u-fetch')),
    denied(() => new WebSocket('ws://127.0.0.1:8791/canary')),
    denied(() => new XMLHttpRequest()),
    denied(() => new EventSource('http://127.0.0.1:8790/canary?source=candidate-u-eventsource')),
    denied(() => new Worker('data:text/javascript,')),
    denied(() => new SharedWorker('data:text/javascript,')),
    denied(() => importScripts('data:text/javascript,')),
    denied(() => new BroadcastChannel('__smallframe_candidate_u__')),
    typeof document === 'undefined'
  ];
  const containedCount = authorityProbes.filter(Boolean).length;
  const authorityContained = containedCount === authorityProbes.length;

  const validDescriptor = {
    view({state, role, online}) {
      const count = publisherObjectKeys(state.decisions ?? {}).length;
      return h('section', {class: ['sf-stack']}, [
        h('p', {}, [text('Role: ' + role + ' · ' + (online ? 'Online' : 'Offline'))]),
        h('p', {class: ['sf-emphasis']}, [text('Decisions: ' + count)]),
        h('p', {}, [text('Lexical isolation: ' + isolatedCount + '/' + lexicalProbes.length)]),
        h('p', {}, [text('Authority probes: ' + containedCount + '/' + authorityProbes.length)]),
        ...(!lexicalIsolation ? [h('p', {}, [text('LEXICAL_AUTHORITY_LEAK')])] : []),
        ...(!authorityContained ? [h('p', {}, [text('AUTHORITY_PROBE_ESCAPE')])] : []),
        h('button', {key: 'add', on: {click: 'add'}}, [text('Add decision')]),
        h('button', {key: 'watchdog', on: {click: 'watchdog'}}, [text('Run bounded watchdog fixture')])
      ]);
    },
    onEvent(event, context) {
      if (event.action === 'add') {
        context.state.batch([{op: 'set', path: ['decisions', context.randomId()], value: {title: 'Untitled'}}]);
      }
      if (event.action === 'watchdog') while (true) {}
    }
  };

  if (fixture === 'missing') return;
  if (fixture === 'invalid-factory') { register(null); return; }
  if (fixture === 'thenable') { register(() => ({then: () => {}})); return; }
  if (fixture === 'malformed') { register(() => ({view: validDescriptor.view})); return; }
  if (fixture === 'oversized') { register(() => ({view: validDescriptor.view, onEvent: validDescriptor.onEvent, payload: 'x'.repeat(300000)})); return; }
  if (fixture === 'hidden-key') {
    const candidate = {...validDescriptor};
    Object.defineProperty(candidate, 'hidden', {value: true, enumerable: false});
    register(() => candidate);
    return;
  }
  if (fixture === 'symbol-key') {
    const candidate = {...validDescriptor};
    candidate[Symbol('hidden')] = true;
    register(() => candidate);
    return;
  }
  if (fixture === 'accessor-result') {
    const candidate = {...validDescriptor};
    Object.defineProperty(candidate, 'onResult', {get: () => () => {}, enumerable: true});
    register(() => candidate);
    return;
  }
  if (fixture === 'reentrant-caught') {
    register(() => {
      try { register(() => validDescriptor); } catch (_) {}
      return validDescriptor;
    });
    return;
  }
  if (fixture === 'named-array') {
    register(() => ({
      ...validDescriptor,
      view(context) {
        const tree = validDescriptor.view(context);
        tree.children.extra = 'x'.repeat(300000);
        return tree;
      }
    }));
    return;
  }
  if (fixture === 'nonfinite') {
    register(() => ({
      ...validDescriptor,
      view(context) {
        const tree = validDescriptor.view(context);
        tree.nonfinite = Number.POSITIVE_INFINITY;
        return tree;
      }
    }));
    return;
  }
  if (fixture === 'sparse-array') {
    register(() => ({
      ...validDescriptor,
      view(context) {
        const tree = validDescriptor.view(context);
        const sparse = new Array(2);
        sparse[0] = tree.children[0];
        tree.children = sparse;
        return tree;
      }
    }));
    return;
  }
  if (fixture === 'array-accessor') {
    register(() => ({
      ...validDescriptor,
      view(context) {
        const tree = validDescriptor.view(context);
        Object.defineProperty(tree.children, '0', {get: () => tree, enumerable: true});
        return tree;
      }
    }));
    return;
  }

  register(() => defineApp(validDescriptor));

  if (fixture === 'duplicate') register(() => defineApp(validDescriptor));

  if (fixture === 'global-forge') {
    try { globalThis.postMessage({channel: 'smallframe-prelude', protocol: 1, session: 'forged', sequence: 1, type: 'render', tree: {text: 'GLOBAL_PROTOCOL_FORGE'}}); } catch (_) {}
  }

  if (fixture === 'poison') {
    const poison = () => { throw new Error('PUBLISHER_INTRINSIC_POISONED'); };
    const replace = (target, key, value) => { try { Object.defineProperty(target, key, {value, configurable: true, writable: true}); } catch (_) {} };
    replace(Function.prototype, 'call', poison);
    replace(Function.prototype, 'apply', poison);
    replace(Reflect, 'apply', poison);
    replace(Reflect, 'get', poison);
    replace(Reflect, 'ownKeys', poison);
    replace(JSON, 'stringify', poison);
    replace(Number, 'isSafeInteger', poison);
    replace(Date, 'now', poison);
    replace(Math, 'floor', poison);
    replace(Set.prototype, 'has', poison);
    replace(Set.prototype, 'add', poison);
    replace(Set.prototype, 'delete', poison);
    replace(Array.prototype, 'slice', poison);
    replace(Array.prototype, 'sort', poison);
    replace(Array.prototype, 'join', poison);
    replace(Object.prototype, 'toJSON', poison);
    replace(Object.prototype, 'hasOwnProperty', poison);
    replace(Object.prototype, 'value', poison);
    replace(Object.prototype, 'onResult', poison);
    replace(Array.prototype, 'toJSON', poison);
    replace(MessagePort.prototype, 'postMessage', poison);
    replace(MessagePort.prototype, 'addEventListener', poison);
    replace(MessagePort.prototype, 'start', poison);
    replace(MessagePort.prototype, 'close', poison);
    replace(Event.prototype, 'stopImmediatePropagation', poison);
    replace(TextEncoder.prototype, 'encode', poison);
    replace(crypto, 'getRandomValues', poison);
    replace(globalThis, 'structuredClone', poison);
    try { Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength', {get: () => 0, configurable: true}); } catch (_) {}
    replace(Object, 'keys', poison);
    replace(Object, 'getPrototypeOf', poison);
    replace(Object, 'getOwnPropertyDescriptor', poison);
    replace(Object, 'create', poison);
    replace(Object, 'setPrototypeOf', poison);
    replace(Object, 'defineProperty', poison);
  }
})();
