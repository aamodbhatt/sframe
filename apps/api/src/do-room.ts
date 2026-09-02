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

import {verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {
  computeWriteMessage,
  computeEnvelopeDigest,
  computeEtag,
  type WireEnvelope
} from '../../../packages/protocol/src/index.js';

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
  recovery_status?: string | null;
  previous_envelope_digest?: string | null;
  writer_public_key?: ArrayBuffer | null;
  writer_signature?: ArrayBuffer | null;
  envelope_salt?: string | null;
  aad_json?: string | null;
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

const parseRoomRoute = (pathname: string): {roomId: string; action: 'meta' | 'state' | 'events' | 'events-ticket' | 'socket' | 'rotate-links' | 'revoke' | 'request-repair' | 'recover'} | null => {
  const metaMatch = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})$/u.exec(pathname);
  if (metaMatch && ROOM_ID_RE.test(metaMatch[1]!)) return {roomId: metaMatch[1]!, action: 'meta'};
  const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(state|events|events-ticket|socket|rotate-links|revoke|request-repair|recover)$/u.exec(pathname);
  if (!match || !match[1] || !match[2] || !ROOM_ID_RE.test(match[1])) return null;
  return {roomId: match[1], action: match[2] as 'meta' | 'state' | 'events' | 'events-ticket' | 'socket' | 'rotate-links' | 'revoke' | 'request-repair' | 'recover'};
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
        etag TEXT NOT NULL UNIQUE,
        recovery_status TEXT DEFAULT 'ACTIVE',
        previous_envelope_digest TEXT,
        writer_public_key BLOB,
        writer_signature BLOB,
        envelope_salt TEXT,
        aad_json TEXT
      ) STRICT
    `).toArray();
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN recovery_status TEXT DEFAULT "ACTIVE"'); } catch {}
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN previous_envelope_digest TEXT'); } catch {}
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN writer_public_key BLOB'); } catch {}
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN writer_signature BLOB'); } catch {}
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN envelope_salt TEXT'); } catch {}
    try { this.ctx.storage.sql.exec('ALTER TABLE room_state ADD COLUMN aad_json TEXT'); } catch {}
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recovery_transition_log (
        epoch INTEGER PRIMARY KEY,
        transition_record TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
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

  private async dispatchPhase0(url: URL, request: Request): Promise<Response | null> {
    const envelopeMatch = /^\/__phase0\/rooms\/([A-Za-z0-9_-]{22})\/init-envelope$/u.exec(url.pathname);
    if (envelopeMatch?.[1]) return this.initializeEncryptedForLocalTest(envelopeMatch[1], request);
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
    return null;
  }

  // Test-only bootstrap: the production publisher saga must eventually supply this
  // same pinned genesis atomically. Never expose this route outside local mode.
  private async initializeEncryptedForLocalTest(roomId: string, request: Request): Promise<Response> {
    if (this.env.ENVIRONMENT !== 'local' || request.method !== 'POST') return problem(404, 'NOT_FOUND');
    const bounded = await readBoundedBody(request, 724_992);
    if (bounded.kind !== 'ok') return problem(400, 'BODY_INVALID');
    try {
      const body = JSON.parse(new TextDecoder().decode(bounded.body));
      const viewer = decodeFixed32(body.viewerCapHash);
      const editor = decodeFixed32(body.editorCapHash);
      const envelope = this.parsePutWireEnvelope(new TextEncoder().encode(JSON.stringify(body.envelope)));
      if (!viewer || !editor || !envelope) return problem(400, 'BODY_INVALID');
      if (!Number.isSafeInteger(body.expiresAtMs) || body.expiresAtMs <= Date.now()) return problem(400, 'EXPIRY_INVALID');
      const zero = encodeBase64Url(new Uint8Array(32));
      const initial = {room_id: roomId, state_epoch: 0, revision: 0, envelope_digest: zero} as RoomRow;
      const verified = await this.verifyWireEnvelope(envelope, initial);
      if (!verified.ok) return problem(verified.status, verified.code);
      const created = this.ctx.storage.transactionSync(() => {
        if (this.loadRoom(roomId)) return false;
        this.ctx.storage.sql.exec(`INSERT INTO room_state (
          singleton, room_id, viewer_cap_hash, editor_cap_hash, expires_at_ms,
          state_epoch, revision, envelope_digest, ciphertext, etag, recovery_status,
          previous_envelope_digest, writer_public_key, writer_signature, envelope_salt, aad_json
        ) VALUES (1, ?, ?, ?, ?, 0, 1, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
        roomId, exactArrayBuffer(viewer), exactArrayBuffer(editor), body.expiresAtMs,
        verified.envelopeDigest, exactArrayBuffer(verified.cipherBytes), verified.etag,
        zero, exactArrayBuffer(verified.writerPubBytes), exactArrayBuffer(verified.writerSigBytes),
        envelope.envelopeSalt, JSON.stringify(envelope.aad)).toArray();
        return true;
      });
      return created ? new Response(null, {status: 201}) : problem(409, 'INITIALIZATION_CONFLICT');
    } catch {
      return problem(400, 'BODY_INVALID');
    }
  }

  private async dispatchAction(action: string, request: Request, room: RoomRow): Promise<Response> {
    const method = request.method;
    if (method === 'GET') {
      if (action === 'meta') return this.getMetadata(request, room);
      if (action === 'state') return this.getState(request, room);
      if (action === 'events') return this.heldEvents(request, room);
      if (action === 'socket') return this.upgradeSocket(request, room);
    } else if (method === 'POST') {
      if (action === 'events-ticket') return this.mintTicket(request, room);
      if (action === 'rotate-links') return this.rotateLinks(request, room);
      if (action === 'revoke') return this.revokeRoom(request, room);
      if (action === 'request-repair') return this.requestRepair(request, room);
      if (action === 'recover') return this.recoverRoom(request, room);
    } else if (method === 'PUT' && action === 'state') {
      return this.putState(request, room);
    }
    return problem(405, 'METHOD_NOT_ALLOWED');
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const phase0 = await this.dispatchPhase0(url, request);
    if (phase0) return phase0;

    const route = parseRoomRoute(url.pathname);
    if (!route) return problem(404, 'NOT_FOUND');
    if (route.action !== 'socket' && request.headers.get('Origin') !== this.controllerOrigin) {
      return problem(403, 'ORIGIN_INVALID');
    }

    const room = this.loadRoom(route.roomId);
    if (!room) return problem(404, 'NOT_FOUND');

    return this.dispatchAction(route.action, request, room);
  }

  private async getMetadata(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room)) return problem(403, 'ROOM_AUTH_INVALID');
    return new Response(JSON.stringify({
      roomId: room.room_id,
      stateEpoch: room.state_epoch,
      revision: room.revision,
      envelopeDigest: room.envelope_digest,
      etag: room.etag,
      expiresAtMs: room.expires_at_ms,
      isRevoked: room.revoked_at_ms !== null,
    }), {headers: jsonHeaders});
  }

  private async rotateLinks(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room, true)) return problem(403, 'ROOM_AUTH_INVALID');
    let body: any;
    try {
      body = await request.json();
    } catch {
      return problem(400, 'BODY_INVALID');
    }
    const viewerHash = decodeFixed32(body?.viewerCapHash);
    const editorHash = decodeFixed32(body?.editorCapHash);
    if (!viewerHash || !editorHash) return problem(400, 'BODY_INVALID');

    this.ctx.storage.sql.exec(
      `UPDATE room_state SET viewer_cap_hash = ?, editor_cap_hash = ? WHERE singleton = 1 AND room_id = ?`,
      exactArrayBuffer(viewerHash),
      exactArrayBuffer(editorHash),
      room.room_id
    ).toArray();

    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1008, 'links rotated'); } catch {}
    }
    return new Response(JSON.stringify({ok: true}), {headers: jsonHeaders});
  }

  private async revokeRoom(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room, true)) return problem(403, 'ROOM_AUTH_INVALID');
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE room_state SET revoked_at_ms = ? WHERE singleton = 1 AND room_id = ?`,
      now,
      room.room_id
    ).toArray();

    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1008, 'room revoked'); } catch {}
    }
    return new Response(JSON.stringify({ok: true, revokedAt: now}), {headers: jsonHeaders});
  }

  private async requestRepair(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room, true)) return problem(403, 'ROOM_AUTH_INVALID');
    this.ctx.storage.sql.exec(
      `UPDATE room_state SET recovery_status = 'RECOVERY_REQUIRED' WHERE singleton = 1 AND room_id = ?`,
      room.room_id
    ).toArray();

    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1008, 'recovery required'); } catch {}
    }
    return new Response(JSON.stringify({ok: true, status: 'RECOVERY_REQUIRED'}), {headers: jsonHeaders});
  }

  private async recoverRoom(request: Request, room: RoomRow): Promise<Response> {
    if (!await this.authorize(request, room, true)) return problem(403, 'ROOM_AUTH_INVALID');
    // Signed epoch recovery is not implemented yet. Do not allow the legacy
    // opaque-byte test hook to reset an encrypted room without its signatures.
    if (room.aad_json) return problem(503, 'SIGNED_RECOVERY_NOT_IMPLEMENTED');
    let body: any;
    try {
      body = await request.json();
    } catch {
      return problem(400, 'BODY_INVALID');
    }
    const newEpoch = typeof body?.newEpoch === 'number' ? body.newEpoch : room.state_epoch + 1;
    const ciphertext = typeof body?.ciphertext === 'string' ? decodeBase64Url(body.ciphertext, MAX_STATE_BYTES) : null;
    if (!ciphertext) return problem(400, 'BODY_INVALID');
    const digest = encodeBase64Url(await sha256(ciphertext));
    const etag = this.etag(newEpoch, 1, digest);

    this.ctx.storage.sql.exec(
      `UPDATE room_state SET state_epoch = ?, revision = 1, envelope_digest = ?, ciphertext = ?, etag = ?, recovery_status = 'ACTIVE' WHERE singleton = 1 AND room_id = ?`,
      newEpoch,
      digest,
      exactArrayBuffer(ciphertext),
      etag,
      room.room_id
    ).toArray();

    const hint: RevisionHint = {type: 'revision', epoch: newEpoch, revision: 1, envelopeDigest: digest};
    this.publishHint(hint);
    return new Response(JSON.stringify({ok: true, epoch: newEpoch, revision: 1, etag}), {headers: jsonHeaders});
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
              state_epoch, revision, envelope_digest, ciphertext, etag,
              recovery_status, previous_envelope_digest, writer_public_key,
              writer_signature, envelope_salt, aad_json
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
    if (room.recovery_status === 'RECOVERY_REQUIRED') {
      return new Response(JSON.stringify({
        status: 'RECOVERY_REQUIRED',
        stateEpoch: room.state_epoch,
        revision: room.revision,
        etag: room.etag,
      }), {
        status: 503,
        headers: {
          ...jsonHeaders,
          ...this.corsHeaders(),
          ETag: room.etag,
          'X-Smallframe-State-Epoch': String(room.state_epoch),
          'X-Smallframe-Revision': String(room.revision),
          'X-Smallframe-Envelope-Digest': room.envelope_digest,
        }
      });
    }

    const headers = {
      ...noStoreHeaders,
      ...this.corsHeaders(),
      ETag: room.etag,
      'X-Smallframe-State-Epoch': String(room.state_epoch),
      'X-Smallframe-Revision': String(room.revision),
      'X-Smallframe-Envelope-Digest': room.envelope_digest,
    };
    if (request.headers.get('If-None-Match') === room.etag) return new Response(null, {status: 304, headers});

    if (room.aad_json) {
      const wireEnvelope = {
        version: 1,
        stateEpoch: room.state_epoch,
        proposedRevision: room.revision,
        envelopeSalt: room.envelope_salt ?? '',
        previousEnvelopeDigest: room.previous_envelope_digest ?? '',
        ciphertext: encodeBase64Url(bytesFromSql(room.ciphertext)),
        writerPublicKey: room.writer_public_key ? encodeBase64Url(bytesFromSql(room.writer_public_key)) : '',
        writerSignature: room.writer_signature ? encodeBase64Url(bytesFromSql(room.writer_signature)) : '',
        aad: JSON.parse(room.aad_json)
      };
      return new Response(JSON.stringify(wireEnvelope), {
        headers: {...headers, 'Content-Type': 'application/json; charset=utf-8'}
      });
    }

    return new Response(room.ciphertext, {
      headers: {...headers, 'Content-Type': 'application/octet-stream'}
    });
  }

  private parsePutWireEnvelope(body: Uint8Array): WireEnvelope | null {
    try {
      const text = new TextDecoder().decode(body);
      if (!text.trim().startsWith('{')) return null;
      const parsed = JSON.parse(text);
      if (this.validEnvelopeShape(parsed)) {
        return parsed as WireEnvelope;
      }
    } catch {}
    return null;
  }

  private validEnvelopeShape(value: any): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = ['version', 'stateEpoch', 'proposedRevision', 'envelopeSalt', 'previousEnvelopeDigest', 'ciphertext', 'writerPublicKey', 'writerSignature', 'aad'];
    if (Object.keys(value).sort().join() !== [...keys].sort().join() || value.version !== 1) return false;
    if (![value.stateEpoch, value.proposedRevision].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
    if (!keys.slice(3, 8).every((key) => typeof value[key] === 'string')) return false;
    const aad = value.aad;
    if (!aad || typeof aad !== 'object' || Array.isArray(aad)) return false;
    const aadKeys = ['protocolVersion', 'appId', 'roomId', 'packageDigest', 'stateEpoch', 'proposedRevision', 'previousEnvelopeDigest'];
    if (Object.keys(aad).sort().join() !== aadKeys.sort().join()) return false;
    return aad.protocolVersion === 1 && ['appId', 'roomId', 'packageDigest', 'previousEnvelopeDigest'].every((key) => typeof aad[key] === 'string');
  }

  private envelopeContextFailure(wireEnvelope: WireEnvelope, initialRoom: RoomRow) {
    if (wireEnvelope.version !== 1) return {ok: false as const, status: 400, code: 'ENVELOPE_VERSION_INVALID'};
    if (wireEnvelope.aad.roomId !== initialRoom.room_id) return {ok: false as const, status: 400, code: 'ROOM_ID_AAD_MISMATCH'};
    if (wireEnvelope.stateEpoch !== initialRoom.state_epoch) return {ok: false as const, status: 409, code: 'EPOCH_MISMATCH'};
    if (wireEnvelope.proposedRevision !== initialRoom.revision + 1) return {ok: false as const, status: 409, code: 'REVISION_CONFLICT'};
    if (wireEnvelope.previousEnvelopeDigest !== initialRoom.envelope_digest) return {ok: false as const, status: 409, code: 'PREDECESSOR_MISMATCH'};
    const aad = wireEnvelope.aad;
    if (aad.stateEpoch !== wireEnvelope.stateEpoch || aad.proposedRevision !== wireEnvelope.proposedRevision || aad.previousEnvelopeDigest !== wireEnvelope.previousEnvelopeDigest) {
      return {ok: false as const, status: 400, code: 'AAD_TUPLE_MISMATCH'};
    }
    if (initialRoom.aad_json) {
      const pinned = JSON.parse(initialRoom.aad_json);
      if (aad.packageDigest !== pinned.packageDigest || aad.appId !== pinned.appId) return {ok: false as const, status: 403, code: 'PACKAGE_CONTEXT_MISMATCH'};
    }
    return null;
  }

  private async verifyWireEnvelope(wireEnvelope: WireEnvelope, initialRoom: RoomRow) {
    const contextFailure = this.envelopeContextFailure(wireEnvelope, initialRoom);
    if (contextFailure) return contextFailure;

    const writerPubBytes = decodeFixed32(wireEnvelope.writerPublicKey);
    const writerSigBytes = decodeBase64Url(wireEnvelope.writerSignature, 64);
    const cipherBytes = decodeBase64Url(wireEnvelope.ciphertext, MAX_STATE_BYTES);
    const saltBytes = decodeBase64Url(wireEnvelope.envelopeSalt, 16);
    const rawRoomId = decodeBase64Url(wireEnvelope.aad.roomId, 16);
    const rawPackageDigest = decodeBase64Url(wireEnvelope.aad.packageDigest, 32);
    const rawPrevDigest = decodeBase64Url(wireEnvelope.previousEnvelopeDigest, 32);

    if (!writerPubBytes || !writerSigBytes || !cipherBytes || !saltBytes || !rawRoomId || !rawPackageDigest || !rawPrevDigest) {
      return {ok: false as const, status: 400, code: 'ENVELOPE_FIELDS_INVALID'};
    }
    if (writerSigBytes.byteLength !== 64 || saltBytes.byteLength !== 16 || rawRoomId.byteLength !== 16 || rawPackageDigest.byteLength !== 32 || rawPrevDigest.byteLength !== 32) {
      return {ok: false as const, status: 400, code: 'WRITER_SIGNATURE_INVALID'};
    }
    if (initialRoom.writer_public_key && !constantTimeEqual32(writerPubBytes, bytesFromSql(initialRoom.writer_public_key))) {
      return {ok: false as const, status: 403, code: 'WRITER_PUBLIC_KEY_MISMATCH'};
    }

    const aadBytes = new TextEncoder().encode(canonicalize(wireEnvelope.aad)!);
    const writeMessage = await computeWriteMessage(
      rawRoomId, rawPackageDigest, wireEnvelope.stateEpoch, wireEnvelope.proposedRevision,
      rawPrevDigest, saltBytes, aadBytes, cipherBytes
    );
    const validSig = await verifyAsync(writerSigBytes, writeMessage, writerPubBytes);
    if (!validSig) return {ok: false as const, status: 400, code: 'WRITER_SIGNATURE_INVALID'};

    const unsignedEnvelope = {
      version: 1, stateEpoch: wireEnvelope.stateEpoch, proposedRevision: wireEnvelope.proposedRevision,
      envelopeSalt: wireEnvelope.envelopeSalt, previousEnvelopeDigest: wireEnvelope.previousEnvelopeDigest,
      ciphertext: wireEnvelope.ciphertext, writerPublicKey: wireEnvelope.writerPublicKey, aad: wireEnvelope.aad
    };
    const envelopeDigestBytes = await computeEnvelopeDigest(unsignedEnvelope, writerSigBytes);
    const envelopeDigest = encodeBase64Url(envelopeDigestBytes);
    const etag = computeEtag(wireEnvelope.stateEpoch, wireEnvelope.proposedRevision, envelopeDigestBytes);

    return {ok: true as const, writerPubBytes, writerSigBytes, cipherBytes, envelopeDigest, etag};
  }

  private commitWireEnvelope(
    initialRoom: RoomRow,
    wireEnvelope: WireEnvelope,
    verified: {writerPubBytes: Uint8Array; writerSigBytes: Uint8Array; cipherBytes: Uint8Array; envelopeDigest: string; etag: string},
    ifMatch: string
  ): {epoch: number; revision: number; digest: string; etag: string} | null | false {
    return this.ctx.storage.transactionSync(() => {
      const current = this.loadRoom(initialRoom.room_id);
      if (!current || !this.isActive(current)) return null;
      if (current.etag !== ifMatch) return false;
      if (current.recovery_status === 'RECOVERY_REQUIRED') return null;

      this.ctx.storage.sql.exec(
        `UPDATE room_state
         SET revision = ?, envelope_digest = ?, ciphertext = ?, etag = ?,
             previous_envelope_digest = ?, writer_public_key = ?, writer_signature = ?,
             envelope_salt = ?, aad_json = ?
         WHERE singleton = 1 AND room_id = ? AND etag = ?`,
        wireEnvelope.proposedRevision,
        verified.envelopeDigest,
        exactArrayBuffer(verified.cipherBytes),
        verified.etag,
        wireEnvelope.previousEnvelopeDigest,
        exactArrayBuffer(verified.writerPubBytes),
        exactArrayBuffer(verified.writerSigBytes),
        wireEnvelope.envelopeSalt,
        JSON.stringify(wireEnvelope.aad),
        current.room_id,
        current.etag,
      ).toArray();
      return {epoch: current.state_epoch, revision: wireEnvelope.proposedRevision, digest: verified.envelopeDigest, etag: verified.etag};
    });
  }

  private commitRawState(initialRoom: RoomRow, body: Uint8Array, ifMatch: string, digest: string): {epoch: number; revision: number; digest: string; etag: string} | null | false {
    return this.ctx.storage.transactionSync(() => {
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
  }

  private async putState(request: Request, initialRoom: RoomRow): Promise<Response> {
    if (!await this.authorize(request, initialRoom, true)) return problem(403, 'ROOM_AUTH_INVALID');
    if (initialRoom.recovery_status === 'RECOVERY_REQUIRED') return problem(503, 'RECOVERY_REQUIRED');

    const ifMatch = request.headers.get('If-Match');
    if (!ifMatch) return problem(428, 'IF_MATCH_REQUIRED');

    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('application/octet-stream')) {
      return problem(415, 'CONTENT_TYPE_INVALID');
    }

    const maxLimit = contentType.includes('application/json') ? 720_896 : MAX_STATE_BYTES;
    const declaredLength = request.headers.get('Content-Length');
    if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxLimit)) return problem(413, 'STATE_TOO_LARGE');

    const boundedBody = await readBoundedBody(request, maxLimit);
    if (boundedBody.kind === 'too-large') return problem(413, 'STATE_TOO_LARGE');
    if (boundedBody.kind === 'invalid') return problem(400, 'BODY_INVALID');
    const body = boundedBody.body;
    if (body.byteLength === 0) return problem(400, 'STATE_EMPTY');

    const wireEnvelope = this.parsePutWireEnvelope(body);
    if (!wireEnvelope && !this.allowLegacyRaw(initialRoom, contentType)) return problem(400, 'SIGNED_ENVELOPE_REQUIRED');
    if (wireEnvelope) {
      const verified = await this.verifyWireEnvelope(wireEnvelope, initialRoom);
      if (!verified.ok) return problem(verified.status, verified.code);

      const committed = this.commitWireEnvelope(initialRoom, wireEnvelope, verified, ifMatch);
      return this.committedResponse(committed);
    }

    const digest = encodeBase64Url(await sha256(body));
    const committed = this.commitRawState(initialRoom, body, ifMatch, digest);
    return this.committedResponse(committed);
  }

  private allowLegacyRaw(room: RoomRow, contentType: string): boolean {
    return this.env.ENVIRONMENT === 'local' && !room.aad_json && contentType === 'application/octet-stream';
  }

  private committedResponse(committed: {epoch: number; revision: number; digest: string; etag: string} | null | false): Response {
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
