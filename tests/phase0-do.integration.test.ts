import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Miniflare} from 'miniflare';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'vite';
import WebSocket from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const WORKER_NAME = 'smallframe-phase0-do';
const DO_CLASS = 'RoomDurableObject';

let temporaryDirectory = '';
let miniflare: Miniflare;
let apiOrigin = '';

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const hash = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest();
const roomId = (fill: number): string => base64url(Uint8Array.from({length: 16}, () => fill));
const capability = (fill: number): string => base64url(Uint8Array.from({length: 32}, () => fill));
const capabilityHash = (encoded: string): string => base64url(hash(Buffer.from(encoded, 'base64url')));
const authorization = (encoded: string): string => `SF-Cap ${encoded}`;
const stateUrl = (room: string): string => `${apiOrigin}/v1/rooms/${room}/state`;
const ticketUrl = (room: string): string => `${apiOrigin}/v1/rooms/${room}/events-ticket`;
const eventsUrl = (room: string): string => `${apiOrigin}/v1/rooms/${room}/events`;
const socketUrl = (room: string): string => `${apiOrigin.replace(/^http/u, 'ws')}/v1/rooms/${room}/socket`;

const initializeRoom = async (
  room: string,
  viewer: string,
  editor: string,
  ciphertext = Uint8Array.of(1),
  expiresAtMs = Date.now() + 3_600_000,
): Promise<Response> => fetch(
  `${apiOrigin}/__phase0/rooms/${room}/init`,
  {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      viewerCapHash: capabilityHash(viewer),
      editorCapHash: capabilityHash(editor),
      expiresAtMs,
      ciphertext: base64url(ciphertext),
    }),
  },
);

const getState = (room: string, cap: string): Promise<Response> => fetch(stateUrl(room), {
  headers: {Authorization: authorization(cap), Origin: CONTROLLER_ORIGIN},
});

const putState = (room: string, cap: string, etag: string, body: Uint8Array): Promise<Response> => fetch(stateUrl(room), {
  method: 'PUT',
  headers: {
    Authorization: authorization(cap),
    'Content-Type': 'application/octet-stream',
    'If-Match': etag,
    Origin: CONTROLLER_ORIGIN,
  },
  body,
});

type MintedTicket = {ticket: string; issuedAtMs: number; expiresAtMs: number};

const mintTicket = async (room: string, cap: string): Promise<MintedTicket> => {
  const response = await fetch(ticketUrl(room), {
    method: 'POST',
    headers: {Authorization: authorization(cap), Origin: CONTROLLER_ORIGIN},
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<MintedTicket>;
};

const openSocket = (room: string, ticket: string, origin = CONTROLLER_ORIGIN): Promise<WebSocket> => new Promise((resolveSocket, reject) => {
  const socket = new WebSocket(socketUrl(room), ['smallframe.v1', `sf-ticket.${ticket}`], {origin});
  socket.once('open', () => resolveSocket(socket));
  socket.once('unexpected-response', (_request, response) => {
    response.resume();
    reject(new Error(`WEBSOCKET_STATUS_${response.statusCode ?? 0}`));
  });
  socket.once('error', reject);
});

const rejectedSocketStatus = (room: string, ticket: string, origin = CONTROLLER_ORIGIN): Promise<number> => new Promise((resolveStatus, reject) => {
  const socket = new WebSocket(socketUrl(room), ['smallframe.v1', `sf-ticket.${ticket}`], {origin});
  let settled = false;
  socket.once('open', () => {
    settled = true;
    socket.close();
    reject(new Error('WEBSOCKET_UNEXPECTEDLY_OPENED'));
  });
  socket.once('unexpected-response', (_request, response) => {
    settled = true;
    const status = response.statusCode ?? 0;
    response.resume();
    resolveStatus(status);
  });
  socket.once('error', (error) => {
    if (!settled) reject(error);
  });
});

const expectSocketRejection = async (label: string, room: string, ticket: string, origin = CONTROLLER_ORIGIN): Promise<void> => {
  try {
    expect(await rejectedSocketStatus(room, ticket, origin)).toBe(403);
  } catch (error) {
    throw new Error(`SOCKET_REJECTION_FAILED_${label}`, {cause: error});
  }
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  const closed = once(socket, 'close');
  socket.close(1000, 'done');
  await closed;
};

const waitForWaiter = async (room: string): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${apiOrigin}/__phase0/rooms/${room}/status`);
    const status = await response.json() as {waiters: number};
    if (status.waiters === 1) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error('HELD_FETCH_DID_NOT_REGISTER');
};

beforeAll(async () => {
  // workerd module roots cannot escape the repository root, so keep generated test bundles under ignored .wrangler/.
  const testRoot = join(ROOT, '.wrangler');
  await mkdir(testRoot, {recursive: true});
  temporaryDirectory = await mkdtemp(join(testRoot, 'phase0-do-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: true,
      outDir: temporaryDirectory,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      lib: {
        entry: resolve(ROOT, 'apps/api/src/do-test-worker.ts'),
        formats: ['es'],
        fileName: () => 'worker.mjs',
      },
      rollupOptions: {external: ['cloudflare:workers']},
    },
  });
  miniflare = new Miniflare({
    name: WORKER_NAME,
    modules: true,
    scriptPath: join(temporaryDirectory, 'worker.mjs'),
    compatibilityDate: '2026-07-30',
    host: '127.0.0.1',
    port: 0,
    bindings: {
      CONTROLLER_ORIGIN,
      ENVIRONMENT: 'local',
      BUILD_VERSION: 'local',
      API_ORIGIN: 'http://api.localhost:8787',
      WEBSOCKET_ORIGIN: 'ws://api.localhost:8787',
      PHASE0_HOLD_MS: '120',
      PHASE0_MAX_TRANSPORTS: '1',
    },
    d1Databases: ['DB'],
    r2Buckets: ['PACKAGES'],
    durableObjects: {ROOMS: {className: DO_CLASS, useSQLite: true}},
    unsafeInspectDurableObjects: true,
  });
  apiOrigin = (await miniflare.ready).origin;
}, 30_000);

afterAll(async () => {
  await miniflare?.dispose();
  if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
});

describe('SQLite Durable Object Phase 0 spike', () => {
  it('validates the production entry environment and applies central local security headers', async () => {
    const response = await fetch(`${apiOrigin}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('stores an immutable ciphertext CAS in SQLite and admits one competing writer', async () => {
    const room = roomId(1);
    const viewer = capability(11);
    const editor = capability(12);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);

    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: room});
    const schema = await storage.exec<{name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(schema.map((entry) => entry.name)).toEqual(expect.arrayContaining(['event_tickets', 'room_state']));
    const initialized = await storage.exec<{revision: number; ciphertext_bytes: number; etag: string}>(
      'SELECT revision, length(ciphertext) AS ciphertext_bytes, etag FROM room_state',
    );
    expect(initialized).toEqual([{revision: 1, ciphertext_bytes: 1, etag: expect.stringMatching(/^"sf1\.0\.1\./u)}]);

    const first = await getState(room, editor);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('Access-Control-Expose-Headers')).toBe('ETag, X-Smallframe-State-Epoch, X-Smallframe-Revision, X-Smallframe-Envelope-Digest');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(Uint8Array.of(1));
    const unchanged = await fetch(stateUrl(room), {headers: {
      Authorization: authorization(viewer),
      Origin: CONTROLLER_ORIGIN,
      'If-None-Match': etag!,
    }});
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('ETag')).toBe(etag);
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0);

    for (const origin of [undefined, 'http://other.localhost:4173']) {
      const headers: Record<string, string> = {Authorization: authorization(viewer)};
      if (origin) headers.Origin = origin;
      const denied = await fetch(stateUrl(room), {headers});
      expect(denied.status).toBe(403);
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const candidateA = Uint8Array.of(2, 3, 5);
    const candidateB = Uint8Array.of(8, 13, 21);
    const [writeA, writeB] = await Promise.all([
      putState(room, editor, etag!, candidateA),
      putState(room, editor, etag!, candidateB),
    ]);
    expect([writeA.status, writeB.status].sort()).toEqual([204, 409]);
    const conflict = writeA.status === 409 ? writeA : writeB;
    expect(conflict.headers.get('Access-Control-Allow-Origin')).toBe(CONTROLLER_ORIGIN);
    expect((await conflict.json()) as {title: string}).toMatchObject({title: 'REVISION_CONFLICT'});

    const final = await getState(room, viewer);
    const finalBytes = new Uint8Array(await final.arrayBuffer());
    expect([base64url(candidateA), base64url(candidateB)]).toContain(base64url(finalBytes));
    const rows = await storage.exec<{revision: number; ciphertext: ArrayBuffer}>('SELECT revision, ciphertext FROM room_state');
    expect(rows[0]?.revision).toBe(2);
    expect(base64url(new Uint8Array(rows[0]!.ciphertext))).toBe(base64url(finalBytes));
  });

  it('rejects an oversized chunked PUT before buffering beyond the relay limit', async () => {
    const room = roomId(7);
    const viewer = capability(71);
    const editor = capability(72);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);
    const current = await getState(room, editor);
    const etag = current.headers.get('ETag')!;
    await current.arrayBuffer();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(224_289));
        controller.close();
      },
    });
    const requestInit: RequestInit & {duplex: 'half'} = {
      method: 'PUT',
      headers: {
        Authorization: authorization(editor),
        'Content-Type': 'application/octet-stream',
        'If-Match': etag,
        Origin: CONTROLLER_ORIGIN,
      },
      body,
      duplex: 'half',
    };
    const response = await fetch(stateUrl(room), requestInit);
    expect(response.status).toBe(413);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(CONTROLLER_ORIGIN);
    const retained = await getState(room, viewer);
    expect(retained.headers.get('ETag')).toBe(etag);
  });

  it('stores only a ticket hash, selects only smallframe.v1, and consumes a replay', async () => {
    const room = roomId(2);
    const viewer = capability(21);
    const editor = capability(22);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);
    const preflight = await fetch(ticketUrl(room), {method: 'OPTIONS', headers: {
      Origin: CONTROLLER_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization',
    }});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(CONTROLLER_ORIGIN);
    const minted = await mintTicket(room, viewer);
    expect(Buffer.from(minted.ticket, 'base64url')).toHaveLength(32);
    expect(minted.expiresAtMs - minted.issuedAtMs).toBe(30_000);

    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: room});
    const tickets = await storage.exec<{ticket_hash_hex: string; role: string; origin: string; expires_at_ms: number}>(
      'SELECT hex(ticket_hash) AS ticket_hash_hex, role, origin, expires_at_ms FROM event_tickets',
    );
    expect(tickets).toEqual([{
      ticket_hash_hex: createHash('sha256').update(Buffer.from(minted.ticket, 'base64url')).digest('hex').toUpperCase(),
      role: 'viewer',
      origin: CONTROLLER_ORIGIN,
      expires_at_ms: minted.expiresAtMs,
    }]);
    expect(JSON.stringify(tickets)).not.toContain(minted.ticket);

    const socket = await openSocket(room, minted.ticket);
    expect(socket.protocol).toBe('smallframe.v1');
    expect(await rejectedSocketStatus(room, minted.ticket)).toBe(403);
    await closeSocket(socket);
    expect(await storage.exec<{count: number}>('SELECT count(*) AS count FROM event_tickets')).toEqual([{count: 0}]);
  });

  it('consumes a valid ticket even when the upgrade fails its transport limit', async () => {
    const room = roomId(3);
    const viewer = capability(31);
    const editor = capability(32);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);
    const firstTicket = await mintTicket(room, viewer);
    const failedTicket = await mintTicket(room, editor);
    const socket = await openSocket(room, firstTicket.ticket);
    expect(await rejectedSocketStatus(room, failedTicket.ticket)).toBe(429);
    await closeSocket(socket);
    expect(await rejectedSocketStatus(room, failedTicket.ticket)).toBe(403);
  });

  it('binds tickets to the exact room and Origin and rejects an expired hash', async () => {
    const room = roomId(5);
    const otherRoom = roomId(6);
    const viewer = capability(51);
    const editor = capability(52);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);
    expect((await initializeRoom(otherRoom, capability(61), capability(62))).status).toBe(201);

    const wrongOrigin = await mintTicket(room, viewer);
    await expectSocketRejection('ORIGIN', room, wrongOrigin.ticket, 'http://other.localhost:4173');
    await expectSocketRejection('ORIGIN_REPLAY', room, wrongOrigin.ticket);

    const wrongRoom = await mintTicket(room, viewer);
    await expectSocketRejection('ROOM', otherRoom, wrongRoom.ticket);
    const correctlyBound = await openSocket(room, wrongRoom.ticket);
    await closeSocket(correctlyBound);

    const expired = await mintTicket(room, editor);
    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: room});
    await storage.exec('UPDATE event_tickets SET expires_at_ms = 0');
    await expectSocketRejection('EXPIRY', room, expired.ticket);
    expect(await storage.exec<{count: number}>('SELECT count(*) AS count FROM event_tickets')).toEqual([{count: 0}]);
  });

  it('schedules room expiry and removes a silent socket from the server transport count', async () => {
    const room = roomId(8);
    const viewer = capability(81);
    const editor = capability(82);
    const expiresAtMs = Date.now() + 1_000;
    expect((await initializeRoom(room, viewer, editor, Uint8Array.of(1), expiresAtMs)).status).toBe(201);
    const minted = await mintTicket(room, viewer);
    const socket = await openSocket(room, minted.ticket);
    const statusUrl = `${apiOrigin}/__phase0/rooms/${room}/status`;
    expect(await (await fetch(statusUrl)).json()).toMatchObject({sockets: 1});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, expiresAtMs - Date.now() + 50)));
    let sockets = 1;
    for (let attempt = 0; attempt < 40 && sockets !== 0; attempt += 1) {
      const status = await (await fetch(statusUrl)).json() as {sockets: number};
      sockets = status.sockets;
      if (sockets !== 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    expect(sockets).toBe(0);
    socket.terminate();
  });

  it('holds only a current event request, wakes it on commit, and times out boundedly', async () => {
    const room = roomId(4);
    const viewer = capability(41);
    const editor = capability(42);
    expect((await initializeRoom(room, viewer, editor)).status).toBe(201);
    const current = await getState(room, viewer);
    const etag = current.headers.get('ETag')!;
    await current.arrayBuffer();

    const stale = await fetch(eventsUrl(room), {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN, 'If-None-Match': '"stale"'},
    });
    expect(stale.status).toBe(200);
    expect((await stale.json() as {revision: number}).revision).toBe(1);

    const held = fetch(eventsUrl(room), {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN, 'If-None-Match': etag},
    });
    await waitForWaiter(room);
    const write = await putState(room, editor, etag, Uint8Array.of(55, 89));
    expect(write.status).toBe(204);
    const wake = await held;
    expect(wake.status).toBe(200);
    expect(await wake.json()).toMatchObject({type: 'revision', epoch: 0, revision: 2});

    const timeoutStarted = Date.now();
    const timedOut = await fetch(eventsUrl(room), {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN, 'If-None-Match': write.headers.get('ETag')!},
    });
    const elapsed = Date.now() - timeoutStarted;
    expect(timedOut.status).toBe(204);
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1_000);
  });
});
