import {DurableObject, type DurableObjectState, type HibernatableWebSocket} from 'cloudflare:workers';
import {
  CAPABILITY_RE,
  ROOM_ID_RE,
  constantTimeEqual32,
  decodeBase64Url,
  decodeFixed32,
  encodeBase64Url,
  exactArrayBuffer,
  random32,
  sha256,
} from './do-crypto.js';
import {readApiRuntimeConfig, type ApiEnvironment} from './runtime-config.js';

const MAX_STATE_BYTES = 524_288;
const TICKET_TTL_MS = 30_000;
const PRODUCTION_HOLD_MS = 25_000;
const MAX_LIVE_TRANSPORTS = 20;
const SOCKET_PROTOCOL = 'smallframe.v1';
const TICKET_PREFIX = 'sf-ticket.';
const AUTH_PREFIX = 'SF-Cap ';
const EXPOSED_ROOM_HEADERS = 'ETag, X-Smallframe-State-Epoch, X-Smallframe-Revision, X-Smallframe-Envelope-Digest';

type Role = 'viewer' | 'editor';

export type RoomEnvironment = ApiEnvironment;

type RoomRow = {
  room_id: string;
  viewer_cap_hash: ArrayBuffer;
  editor_cap_hash: ArrayBuffer;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  state_epoch: number;
  revision: number;
  envelope_digest: string;
  ciphertext: ArrayBuffer;
  etag: string;
};

type TicketRow = {
  room_id: string;
  role: string;
  origin: string;
  expires_at_ms: number;
};

type RevisionHint = {
  type: 'revision';
  epoch: number;
  revision: number;
  envelopeDigest: string;
};

type SocketAttachment = {
  version: 1;
  role: Role;
  origin: string;
  roomExpiresAt: number;
};

type Waiter = {
  finish: (response: Response) => void;
};

type WebSocketResponseInit = ResponseInit & {webSocket: WebSocket};
type WebSocketPairConstructor = new () => {0: HibernatableWebSocket; 1: HibernatableWebSocket};

const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store'};
const noStoreHeaders = {'Cache-Control': 'private, no-store'};

const problem = (status: number, code: string): Response => new Response(JSON.stringify({
  type: `urn:smallframe:error:${code.toLowerCase()}`,
  title: code,
  status,
}), {status, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'}});

const parseRoomRoute = (pathname: string): {roomId: string; action: 'state' | 'events' | 'events-ticket' | 'socket'} | null => {
  const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(state|events|events-ticket|socket)$/u.exec(pathname);
  if (!match || !match[1] || !match[2] || !ROOM_ID_RE.test(match[1])) return null;
  return {roomId: match[1], action: match[2] as 'state' | 'events' | 'events-ticket' | 'socket'};
};

const bytesFromSql = (value: ArrayBuffer): Uint8Array => new Uint8Array(value);

const asSafeInteger = (value: number): number | null => Number.isSafeInteger(value) ? value : null;

type BoundedBodyResult =
  | {kind: 'ok'; body: Uint8Array}
  | {kind: 'too-large'}
  | {kind: 'invalid'};

const readBoundedBody = async (request: Request, maximumBytes: number): Promise<BoundedBodyResult> => {
  if (!request.body) return {kind: 'ok', body: new Uint8Array()};
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return {kind: 'invalid'};
  }
  const buffer = new Uint8Array(maximumBytes + 1);
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return {kind: 'ok', body: buffer.slice(0, length)};
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) return {kind: 'invalid'};
      if (chunk.byteLength > maximumBytes - length) {
        try {
          await reader.cancel('STATE_TOO_LARGE');
        } catch {
          // A disconnected sender is still an oversized request.
        }
        return {kind: 'too-large'};
      }
      buffer.set(chunk, length);
      length += chunk.byteLength;
    }
  } catch {
    return {kind: 'invalid'};
  } finally {
    reader.releaseLock();
  }
};

export class RoomDurableObject extends DurableObject<RoomEnvironment> {
  private readonly controllerOrigin: string;
  private readonly waiters = new Map<number, Waiter>();
  private nextWaiterId = 1;

  constructor(ctx: DurableObjectState, env: RoomEnvironment) {
    super(ctx, env);
    this.controllerOrigin = readApiRuntimeConfig(env).origins.controller;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL UNIQUE,
        viewer_cap_hash BLOB NOT NULL CHECK (length(viewer_cap_hash) = 32),
        editor_cap_hash BLOB NOT NULL CHECK (length(editor_cap_hash) = 32),
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        state_epoch INTEGER NOT NULL CHECK (state_epoch >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        envelope_digest TEXT NOT NULL,
        ciphertext BLOB NOT NULL CHECK (length(ciphertext) <= 524288),
        etag TEXT NOT NULL UNIQUE
      ) STRICT
    `).toArray();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_tickets (
        ticket_hash BLOB PRIMARY KEY CHECK (length(ticket_hash) = 32),
        room_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        origin TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT
    `).toArray();
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS event_tickets_expiry ON event_tickets(expires_at_ms)').toArray();
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.routeRequest(request);
    return this.withControllerCors(request, response);
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const initMatch = /^\/__phase0\/rooms\/([A-Za-z0-9_-]{22})\/init$/u.exec(url.pathname);
    const initRoomId = initMatch?.[1];
    if (initRoomId && ROOM_ID_RE.test(initRoomId)) return this.initializeForPhase0(initRoomId, request);
    const statusMatch = /^\/__phase0\/rooms\/([A-Za-z0-9_-]{22})\/status$/u.exec(url.pathname);
    const statusRoomId = statusMatch?.[1];
    if (statusRoomId && ROOM_ID_RE.test(statusRoomId) && request.method === 'GET' && this.env.ENVIRONMENT === 'local') {
      const room = this.loadRoom(statusRoomId);
      if (!room) return problem(404, 'NOT_FOUND');
      return new Response(JSON.stringify({waiters: this.waiters.size, sockets: this.ctx.getWebSockets().length}), {headers: jsonHeaders});
    }
    const route = parseRoomRoute(url.pathname);
    if (!route) return problem(404, 'NOT_FOUND');
    if (route.action !== 'socket' && request.headers.get('Origin') !== this.controllerOrigin) {
      return problem(403, 'ORIGIN_INVALID');
    }

    const room = this.loadRoom(route.roomId);
    if (!room) return problem(404, 'NOT_FOUND');

    if (route.action === 'state' && request.method === 'GET') return this.getState(request, room);
    if (route.action === 'state' && request.method === 'PUT') return this.putState(request, room);
    if (route.action === 'events' && request.method === 'GET') return this.heldEvents(request, room);
    if (route.action === 'events-ticket' && request.method === 'POST') return this.mintTicket(request, room);
    if (route.action === 'socket' && request.method === 'GET') return this.upgradeSocket(request, room);
    return problem(405, 'METHOD_NOT_ALLOWED');
  }

  async initializeForPhase0(roomId: string, request: Request): Promise<Response> {
    if (this.env.ENVIRONMENT !== 'local' || !ROOM_ID_RE.test(roomId) || request.method !== 'POST') return problem(404, 'NOT_FOUND');
    if (request.headers.get('Content-Type') !== 'application/json') return problem(415, 'CONTENT_TYPE_INVALID');

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return problem(400, 'BODY_INVALID');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return problem(400, 'BODY_INVALID');
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'ciphertext,editorCapHash,expiresAtMs,viewerCapHash') return problem(400, 'BODY_INVALID');
    if (typeof record.viewerCapHash !== 'string' || typeof record.editorCapHash !== 'string' || typeof record.ciphertext !== 'string' || typeof record.expiresAtMs !== 'number') {
      return problem(400, 'BODY_INVALID');
    }
    const viewerHash = decodeFixed32(record.viewerCapHash);
    const editorHash = decodeFixed32(record.editorCapHash);
    const ciphertext = decodeBase64Url(record.ciphertext, MAX_STATE_BYTES);
    const expiresAtMs = asSafeInteger(record.expiresAtMs);
    if (!viewerHash || !editorHash || !ciphertext || expiresAtMs === null || expiresAtMs <= Date.now()) return problem(400, 'BODY_INVALID');
    const digest = encodeBase64Url(await sha256(ciphertext));
    const etag = this.etag(0, 1, digest);

    try {
      const result = this.ctx.storage.transactionSync(() => {
        const current = this.loadRoom(roomId);
        if (!current) {
          this.ctx.storage.sql.exec(
            `INSERT INTO room_state (
              singleton, room_id, viewer_cap_hash, editor_cap_hash, expires_at_ms, revoked_at_ms,
              state_epoch, revision, envelope_digest, ciphertext, etag
            ) VALUES (1, ?, ?, ?, ?, NULL, 0, 1, ?, ?, ?)`,
            roomId,
            exactArrayBuffer(viewerHash),
            exactArrayBuffer(editorHash),
            expiresAtMs,
            digest,
            exactArrayBuffer(ciphertext),
            etag,
          ).toArray();
          return 'created';
        }
        const identical = current.expires_at_ms === expiresAtMs
          && current.state_epoch === 0
          && current.revision === 1
          && current.envelope_digest === digest
          && current.etag === etag
          && constantTimeEqual32(bytesFromSql(current.viewer_cap_hash), viewerHash)
          && constantTimeEqual32(bytesFromSql(current.editor_cap_hash), editorHash)
          && encodeBase64Url(bytesFromSql(current.ciphertext)) === record.ciphertext;
        if (!identical) throw new Error('INITIALIZATION_CONFLICT');
        return 'existing';
      });
      return new Response(JSON.stringify({status: result, etag}), {status: result === 'created' ? 201 : 200, headers: jsonHeaders});
    } catch (error) {
      if (error instanceof Error && error.message === 'INITIALIZATION_CONFLICT') return problem(409, 'INITIALIZATION_CONFLICT');
      throw error;
    }
  }

  override webSocketMessage(socket: WebSocket): void {
    const hibernatableSocket = socket as HibernatableWebSocket;
    const attachment = hibernatableSocket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.version !== 1 || Date.now() >= attachment.roomExpiresAt) {
      socket.close(1008, 'session ended');
      return;
    }
    socket.close(1003, 'messages unsupported');
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    // Calling close remains safe with automatic close replies and keeps older local runtimes deterministic.
    socket.close(code === 1000 ? 1000 : 1001, 'closed');
  }

  override webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, 'transport error');
    } catch {
      // The peer may already have disappeared.
    }
  }

  override async alarm(): Promise<void> {
    await this.deliverExpiryAlarm();
  }

  private async deliverExpiryAlarm(): Promise<{closed: number; nextExpiry: number | null}> {
    const now = Date.now();
    let nextExpiry: number | null = null;
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.version !== 1 || attachment.roomExpiresAt <= now) {
        try {
          socket.close(1008, 'session ended');
          closed += 1;
        } catch {
          // The peer may already have disappeared.
        }
      } else {
        nextExpiry = nextExpiry === null ? attachment.roomExpiresAt : Math.min(nextExpiry, attachment.roomExpiresAt);
      }
    }
    if (nextExpiry !== null) await this.ctx.storage.setAlarm(nextExpiry);
    return {closed, nextExpiry};
  }

  private loadRoom(roomId: string): RoomRow | null {
    const rows = this.ctx.storage.sql.exec<RoomRow>(
      `SELECT room_id, viewer_cap_hash, editor_cap_hash, expires_at_ms, revoked_at_ms,
              state_epoch, revision, envelope_digest, ciphertext, etag
       FROM room_state WHERE singleton = 1 AND room_id = ?`,
      roomId,
    ).toArray();
    return rows[0] ?? null;
  }

  private etag(epoch: number, revision: number, digest: string): string {
    return `"sf1.${epoch}.${revision}.${digest}"`;
  }

  private isActive(room: RoomRow, now = Date.now()): boolean {
    return room.revoked_at_ms === null && now < room.expires_at_ms;
  }

  private async authorize(request: Request, room: RoomRow, editorOnly = false): Promise<Role | null> {
    if (!this.isActive(room)) return null;
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith(AUTH_PREFIX)) return null;
    const encoded = authorization.slice(AUTH_PREFIX.length);
    if (!CAPABILITY_RE.test(encoded)) return null;
    const raw = decodeFixed32(encoded);
    if (!raw) return null;
    const candidate = await sha256(raw);
    const viewer = constantTimeEqual32(candidate, bytesFromSql(room.viewer_cap_hash));
    const editor = constantTimeEqual32(candidate, bytesFromSql(room.editor_cap_hash));
    if (editor) return 'editor';
    if (viewer && !editorOnly) return 'viewer';
    return null;
  }

  private corsHeaders(): Record<string, string> {
    return {'Access-Control-Allow-Origin': this.controllerOrigin, 'Vary': 'Origin'};
  }

  private withControllerCors(request: Request, response: Response): Response {
    if (response.status === 101 || request.headers.get('Origin') !== this.controllerOrigin) return response;
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', this.controllerOrigin);
    headers.set('Access-Control-Expose-Headers', EXPOSED_ROOM_HEADERS);
    const vary = new Set((headers.get('Vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    vary.add('Origin');
    headers.set('Vary', [...vary].join(', '));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async getState(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room)) return problem(403, 'ROOM_AUTH_INVALID');
    const headers = {
      ...noStoreHeaders,
      ...this.corsHeaders(),
      'Content-Type': 'application/octet-stream',
      ETag: room.etag,
      'X-Smallframe-State-Epoch': String(room.state_epoch),
      'X-Smallframe-Revision': String(room.revision),
      'X-Smallframe-Envelope-Digest': room.envelope_digest,
    };
    if (request.headers.get('If-None-Match') === room.etag) return new Response(null, {status: 304, headers});
    return new Response(room.ciphertext, {headers});
  }

  private async putState(request: Request, initialRoom: RoomRow): Promise<Response> {
    if (!await this.authorize(request, initialRoom, true)) return problem(403, 'ROOM_AUTH_INVALID');
    if (request.headers.get('Content-Type') !== 'application/octet-stream') return problem(415, 'CONTENT_TYPE_INVALID');
    const ifMatch = request.headers.get('If-Match');
    if (!ifMatch) return problem(428, 'IF_MATCH_REQUIRED');
    const declaredLength = request.headers.get('Content-Length');
    if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_STATE_BYTES)) return problem(413, 'STATE_TOO_LARGE');
    const boundedBody = await readBoundedBody(request, MAX_STATE_BYTES);
    if (boundedBody.kind === 'too-large') return problem(413, 'STATE_TOO_LARGE');
    if (boundedBody.kind === 'invalid') return problem(400, 'BODY_INVALID');
    const body = boundedBody.body;
    if (body.byteLength === 0) return problem(400, 'STATE_EMPTY');
    const digest = encodeBase64Url(await sha256(body));

    const committed = this.ctx.storage.transactionSync(() => {
      const current = this.loadRoom(initialRoom.room_id);
      if (!current || !this.isActive(current)) return null;
      if (current.etag !== ifMatch) return false;
      const revision = current.revision + 1;
      const etag = this.etag(current.state_epoch, revision, digest);
      this.ctx.storage.sql.exec(
        `UPDATE room_state
         SET revision = ?, envelope_digest = ?, ciphertext = ?, etag = ?
         WHERE singleton = 1 AND room_id = ? AND etag = ?`,
        revision,
        digest,
        exactArrayBuffer(body),
        etag,
        current.room_id,
        current.etag,
      ).toArray();
      return {epoch: current.state_epoch, revision, digest, etag};
    });

    if (committed === null) return problem(403, 'ROOM_AUTH_INVALID');
    if (committed === false) return problem(409, 'REVISION_CONFLICT');
    const hint: RevisionHint = {type: 'revision', epoch: committed.epoch, revision: committed.revision, envelopeDigest: committed.digest};
    this.publishHint(hint);
    return new Response(null, {status: 204, headers: {...noStoreHeaders, ...this.corsHeaders(), ETag: committed.etag}});
  }

  private hint(room: RoomRow): RevisionHint {
    return {type: 'revision', epoch: room.state_epoch, revision: room.revision, envelopeDigest: room.envelope_digest};
  }

  private hintResponse(hint: RevisionHint): Response {
    return new Response(JSON.stringify(hint), {headers: {...jsonHeaders, ...this.corsHeaders()}});
  }

  private publishHint(hint: RevisionHint): void {
    const serialized = JSON.stringify(hint);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        try {
          socket.close(1011, 'transport error');
        } catch {
          // The socket is already gone.
        }
      }
    }
    for (const waiter of [...this.waiters.values()]) waiter.finish(this.hintResponse(hint));
  }

  private liveTransportCount(): number {
    return this.ctx.getWebSockets().length + this.waiters.size;
  }

  private transportLimit(): number {
    if (this.env.ENVIRONMENT !== 'local' || this.env.PHASE0_MAX_TRANSPORTS === undefined) return MAX_LIVE_TRANSPORTS;
    if (!/^\d+$/u.test(this.env.PHASE0_MAX_TRANSPORTS)) throw new Error('PHASE0_MAX_TRANSPORTS_INVALID');
    const value = Number(this.env.PHASE0_MAX_TRANSPORTS);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIVE_TRANSPORTS) throw new Error('PHASE0_MAX_TRANSPORTS_INVALID');
    return value;
  }

  private holdDuration(): number {
    if (this.env.ENVIRONMENT !== 'local' || this.env.PHASE0_HOLD_MS === undefined) return PRODUCTION_HOLD_MS;
    if (!/^\d+$/u.test(this.env.PHASE0_HOLD_MS)) throw new Error('PHASE0_HOLD_MS_INVALID');
    const value = Number(this.env.PHASE0_HOLD_MS);
    if (!Number.isSafeInteger(value) || value < 10 || value > PRODUCTION_HOLD_MS) throw new Error('PHASE0_HOLD_MS_INVALID');
    return value;
  }

  private async heldEvents(request: Request, room: RoomRow): Promise<Response> {
    if (request.headers.get('Origin') !== this.controllerOrigin) return problem(403, 'ORIGIN_INVALID');
    if (!await this.authorize(request, room)) return problem(403, 'ROOM_AUTH_INVALID');
    const current = this.loadRoom(room.room_id);
    if (!current || !this.isActive(current)) return problem(403, 'ROOM_AUTH_INVALID');
    if (request.headers.get('If-None-Match') !== current.etag) return this.hintResponse(this.hint(current));
    if (this.liveTransportCount() >= this.transportLimit()) return problem(429, 'TRANSPORT_LIMIT');
    if (request.signal.aborted) return new Response(null, {status: 204, headers: {...noStoreHeaders, ...this.corsHeaders()}});

    const waiterId = this.nextWaiterId;
    this.nextWaiterId += 1;
    return new Promise<Response>((resolve) => {
      let complete = false;
      const finish = (response: Response): void => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        this.waiters.delete(waiterId);
        resolve(response);
      };
      const onAbort = (): void => finish(new Response(null, {status: 204, headers: {...noStoreHeaders, ...this.corsHeaders()}}));
      const timer = setTimeout(
        () => finish(new Response(null, {status: 204, headers: {...noStoreHeaders, ...this.corsHeaders(), ETag: current.etag}})),
        this.holdDuration(),
      );
      request.signal.addEventListener('abort', onAbort, {once: true});
      this.waiters.set(waiterId, {finish});
    });
  }

  private async mintTicket(request: Request, room: RoomRow): Promise<Response> {
    if (request.headers.get('Origin') !== this.controllerOrigin) return problem(403, 'ORIGIN_INVALID');
    const role = await this.authorize(request, room);
    if (!role) return problem(403, 'ROOM_AUTH_INVALID');
    if (this.liveTransportCount() >= this.transportLimit()) return problem(429, 'TRANSPORT_LIMIT');
    const now = Date.now();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = random32();
      const ticket = encodeBase64Url(raw);
      const hash = await sha256(raw);
      try {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM event_tickets WHERE expires_at_ms <= ?', now).toArray();
          this.ctx.storage.sql.exec(
            'INSERT INTO event_tickets (ticket_hash, room_id, role, origin, expires_at_ms) VALUES (?, ?, ?, ?, ?)',
            exactArrayBuffer(hash),
            room.room_id,
            role,
            this.controllerOrigin,
            now + TICKET_TTL_MS,
          ).toArray();
        });
        return new Response(JSON.stringify({ticket, issuedAtMs: now, expiresAtMs: now + TICKET_TTL_MS}), {status: 201, headers: {...jsonHeaders, ...this.corsHeaders()}});
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw new Error('TICKET_GENERATION_FAILED');
  }

  private parseTicketProtocol(request: Request): string | null {
    const header = request.headers.get('Sec-WebSocket-Protocol');
    if (!header) return null;
    const protocols = header.split(',').map((entry) => entry.trim());
    if (protocols.length !== 2 || protocols[0] !== SOCKET_PROTOCOL) return null;
    const offeredTicket = protocols[1];
    if (!offeredTicket?.startsWith(TICKET_PREFIX)) return null;
    const ticket = offeredTicket.slice(TICKET_PREFIX.length);
    return CAPABILITY_RE.test(ticket) ? ticket : null;
  }

  private redeemTicket(hash: Uint8Array): TicketRow | null {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<TicketRow>(
        'SELECT room_id, role, origin, expires_at_ms FROM event_tickets WHERE ticket_hash = ?',
        exactArrayBuffer(hash),
      ).toArray();
      const ticket = rows[0] ?? null;
      if (ticket) this.ctx.storage.sql.exec('DELETE FROM event_tickets WHERE ticket_hash = ?', exactArrayBuffer(hash)).toArray();
      return ticket;
    });
  }

  private async upgradeSocket(request: Request, room: RoomRow): Promise<Response> {
    const url = new URL(request.url);
    const encoded = this.parseTicketProtocol(request);
    if (!encoded) return problem(400, 'SOCKET_PROTOCOL_INVALID');
    const raw = decodeFixed32(encoded);
    if (!raw) return problem(400, 'SOCKET_PROTOCOL_INVALID');
    const ticket = this.redeemTicket(await sha256(raw));

    // Redemption commits before every contextual/limit check below. A failure cannot resurrect the ticket.
    const role = ticket?.role === 'viewer' || ticket?.role === 'editor' ? ticket.role : null;
    const requestOrigin = request.headers.get('Origin');
    const requestContextValid = !url.search
      && !request.headers.has('Authorization')
      && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      && requestOrigin === this.controllerOrigin;
    if (!requestContextValid || !ticket || !role || ticket.room_id !== room.room_id || ticket.origin !== requestOrigin || ticket.expires_at_ms <= Date.now() || !this.isActive(room)) {
      return problem(403, 'SOCKET_AUTH_INVALID');
    }
    if (this.liveTransportCount() >= this.transportLimit()) return problem(429, 'TRANSPORT_LIMIT');

    const WebSocketPairRuntime = (globalThis as typeof globalThis & {WebSocketPair: WebSocketPairConstructor}).WebSocketPair;
    const pair = new WebSocketPairRuntime();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({version: 1, role, origin: ticket.origin, roomExpiresAt: room.expires_at_ms} satisfies SocketAttachment);
    await this.ctx.storage.setAlarm(room.expires_at_ms);
    return new Response(null, {
      status: 101,
      headers: {'Sec-WebSocket-Protocol': SOCKET_PROTOCOL, 'Cache-Control': 'no-store'},
      webSocket: client,
    } as WebSocketResponseInit);
  }
}

export const phase0DurableObjectConstants = Object.freeze({
  maxStateBytes: MAX_STATE_BYTES,
  ticketTtlMs: TICKET_TTL_MS,
  heldFetchMs: PRODUCTION_HOLD_MS,
  maxLiveTransports: MAX_LIVE_TRANSPORTS,
  socketProtocol: SOCKET_PROTOCOL,
});
