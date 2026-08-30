const text = (value) => ({text: String(value)});
const node = (tag, props = {}, children = []) => ({tag, ...props, children});

export default {
  view({state, role}) {
    const items = state.items ?? {};
    return node('section', {class: ['sf-stack']}, [
      node('h2', {}, [text('Tiny Tracker')]),
      node('p', {class: ['sf-muted']}, [text(`${role} · ${Object.keys(items).length} items`)]),
      node('button', {key: 'add', on: {click: 'add'}}, [text('Add item')])
    ]);
  },
  onEvent(event, context) {
    if (event.action !== 'add') return;
    context.state.batch([{op: 'set', path: ['items', context.randomId()], value: {label: 'New item', done: false}}]);
  }
};
