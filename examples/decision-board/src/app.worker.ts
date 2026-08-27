export type Decision = {title: string};
export type DecisionState = {decisions: Record<string, Decision>};

// The published fixture is bundled into one self-contained module by the
// example build. This source intentionally has no DOM, imports, or network.
declare const SmallframeSDK: {defineApp: Function; h: Function; text: Function};
const {defineApp, h, text} = SmallframeSDK;
export default defineApp({
  view({state, role, online}: {state: DecisionState; role: string; online: boolean}) {
    return h('section', {class: ['sf-stack']}, [
      h('p', {}, [text(`Role: ${role} · ${online ? 'Online' : 'Offline'}`)]),
      h('p', {class: ['sf-emphasis']}, [text(`Decisions: ${Object.keys(state.decisions ?? {}).length}`)]),
      h('button', {key: 'add', on: {click: 'add'}}, [text('Add decision')])
    ]);
  },
  onEvent(event: {action: string}, context: {state: DecisionState & {batch?: Function}; randomId: () => string}) {
    if (event.action === 'add') context.state.batch?.([{op: 'set', path: ['decisions', context.randomId()], value: {title: 'Untitled'}}]);
  }
});
