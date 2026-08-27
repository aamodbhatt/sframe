declare module 'cloudflare:workers' {
  export type SqlStorageValue = ArrayBuffer | string | number | null;

  export interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
    toArray(): T[];
  }

  export interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  }

  export interface DurableObjectStorage {
    sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }

  export interface HibernatableWebSocket extends WebSocket {
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
  }

  export interface DurableObjectState {
    storage: DurableObjectStorage;
    acceptWebSocket(socket: HibernatableWebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): HibernatableWebSocket[];
  }

  export interface DurableObjectId {
    toString(): string;
  }

  export interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }

  export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    webSocketMessage?(socket: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(socket: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(socket: WebSocket, error: unknown): void | Promise<void>;
    alarm?(): void | Promise<void>;
  }
}
