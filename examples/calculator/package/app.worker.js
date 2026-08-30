const text = (value) => ({text: String(value)});
const node = (tag, props = {}, children = []) => ({tag, ...props, children});

export default {
  view({state, role}) {
    const total = Number.isFinite(state.total) ? state.total : 0;
    return node('section', {class: ['sf-stack']}, [
      node('h2', {}, [text('Pocket Calculator')]),
      node('p', {class: ['sf-emphasis']}, [text(total)]),
      node('p', {class: ['sf-muted']}, [text(`${role} mode`)]),
      node('button', {key: 'increment', on: {click: 'increment'}}, [text('Add one')]),
      node('button', {key: 'double', on: {click: 'double'}}, [text('Double')]),
      node('button', {key: 'clear', on: {click: 'clear'}}, [text('Clear')])
    ]);
  },
  onEvent(event, context) {
    const total = Number.isFinite(context.state.total) ? context.state.total : 0;
    const next = event.action === 'increment' ? total + 1 : event.action === 'double' ? total * 2 : event.action === 'clear' ? 0 : total;
    if (next !== total || event.action === 'clear') context.state.batch([{op: 'set', path: ['total'], value: next}]);
  }
};
