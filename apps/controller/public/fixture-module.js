globalThis.SMALLFRAME_APP_MODULE = `const {defineApp, h, text} = globalThis.SmallframeSDK;
try { fetch('http://localhost:8790/canary?source=worker'); } catch (_) {}
try { new WebSocket('ws://localhost:8791/canary'); } catch (_) {}
try { if (typeof document !== 'undefined') throw new Error('DOM_VISIBLE'); } catch (_) {}
export default defineApp({
  view({state, role, online}) {
    const count = Object.keys(state.decisions ?? {}).length;
    return h('section', {class: ['sf-stack'], children: [
      h('p', {}, [text('Role: ' + role + ' · ' + (online ? 'Online' : 'Offline'))]),
      h('p', {class: ['sf-emphasis']}, [text('Decisions: ' + count)]),
      h('button', {key: 'add', on: {click: 'add'}}, [text('Add decision')])
    ]});
  },
  onEvent(event, context) {
    if (event.action === 'add') context.state.batch([{op: 'set', path: ['decisions', context.randomId()], value: {title: 'Untitled'}}]);
  }
});`;
