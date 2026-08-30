const text = (value) => ({text: String(value)});
const node = (tag, props = {}, children = []) => ({tag, ...props, children});

export default {
  view({state, role, online}) {
    const decisions = state.decisions ?? {};
    return node('section', {class: ['sf-stack']}, [
      node('h2', {}, [text('Decision Board')]),
      node('p', {class: ['sf-muted']}, [text(`${role} · ${online ? 'online' : 'offline'}`)]),
      node('p', {class: ['sf-emphasis']}, [text(`${Object.keys(decisions).length} decisions`)]),
      node('button', {key: 'add', on: {click: 'add'}}, [text('Add decision')])
    ]);
  },
  onEvent(event, context) {
    if (event.action === 'add') {
      context.state.batch([{
        op: 'set',
        path: ['decisions', context.randomId()],
        value: {title: 'Untitled'}
      }]);
    }
  }
};
