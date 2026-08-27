(() => {
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

  // These attempts are intentionally part of the checked-in hostile fixture.
  // Candidate S must deny them before the factory is registered.
  try { fetch('http://localhost:8790/canary?source=candidate-s-factory'); } catch (_) {}
  try { new WebSocket('ws://localhost:8791/canary'); } catch (_) {}
  try { new Worker('data:text/javascript,'); } catch (_) {}
  try { importScripts('data:text/javascript,'); } catch (_) {}
  try { if (typeof document !== 'undefined') throw new Error('DOM_VISIBLE'); } catch (_) {}

  register(() => defineApp({
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
  }));
})();
