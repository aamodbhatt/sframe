export type Role = 'viewer' | 'editor';
export type ViewNode = {text: string} | {tag: string; key?: string; class?: string[]; props?: Record<string, unknown>; on?: Record<string, string>; children?: ViewNode[]};
export type StateOperation = {op: 'set' | 'delete'; path: string[]; value?: unknown};
export type AppContext<S> = {state: S & {batch?: (operations: StateOperation[]) => void}; role: Role; online: boolean; revision: number; randomId: () => string; now: () => number};
export type AppDescriptor<S = unknown> = {view: (context: AppContext<S>) => ViewNode; onEvent: (event: {action: string; key?: string; value?: string; checked?: boolean}, context: AppContext<S>) => void; onResult?: (result: unknown, context: AppContext<S>) => void};
export const defineApp = <S>(descriptor: AppDescriptor<S>): Readonly<AppDescriptor<S>> => Object.freeze(descriptor);
export const h = (tag: string, props: Record<string, unknown> = {}, children: ViewNode[] = []): ViewNode => ({tag, ...(typeof props.key === 'string' ? {key: props.key} : {}), ...(Array.isArray(props.class) ? {class: props.class as string[]} : {}), ...(props.on && typeof props.on === 'object' ? {on: props.on as Record<string, string>} : {}), ...(Object.keys(props).some((key) => !['key', 'class', 'on', 'children'].includes(key)) ? {props: Object.fromEntries(Object.entries(props).filter(([key]) => !['key', 'class', 'on', 'children'].includes(key)))} : {}), children});
export const text = (value: string | number | boolean): ViewNode => ({text: String(value)});
