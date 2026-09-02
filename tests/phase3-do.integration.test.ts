import {createHash, randomBytes} from 'node:crypto';
import {encryptSnapshot} from '../packages/protocol/src/crypto-envelope.js';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Miniflare} from 'miniflare';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const WORKER_NAME = 'smallframe-phase3-do';
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

describe('SQLite Durable Object Phase 3 Protocol & Lifecycle', () => {
  it('pins encrypted genesis and rejects raw downgrade, wrong writer/package, viewer writes, forged signatures and legacy recovery', async () => {
    const room = base64url(randomBytes(16));
    const viewer = base64url(randomBytes(32));
    const editor = base64url(randomBytes(32));
    const params = {roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: new Uint8Array(randomBytes(32)),
      roomId: room, appId: 'test.room', packageDigest: base64url(randomBytes(32)), stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: base64url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1, 2, 3)};
    const genesis = await encryptSnapshot(params);
    const init = await fetch(`${apiOrigin}/__phase0/rooms/${room}/init-envelope`, {method: 'POST', body: JSON.stringify({
      viewerCapHash: capabilityHash(viewer), editorCapHash: capabilityHash(editor), expiresAtMs: Date.now() + 60_000, envelope: genesis.envelope
    })});
    expect(init.status).toBe(201);
    const nextParams = {...params, proposedRevision: 2, previousEnvelopeDigest: base64url(genesis.envelopeDigest)};
    const next = await encryptSnapshot(nextParams);
    const put = (body: unknown, cap = editor, contentType = 'application/json') => fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      method: 'PUT', headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(cap), 'If-Match': genesis.etag, 'Content-Type': contentType},
      body: JSON.stringify(body)
    });
    expect((await put({untrusted: true}, editor, 'application/octet-stream')).status).toBe(400);
    expect((await put({version: 1})).status).toBe(400);
    expect((await put(next.envelope, viewer)).status).toBe(403);
    const forged = {...next.envelope, writerSignature: base64url(randomBytes(64))};
    expect((await put(forged)).status).toBe(400);
    const wrongWriter = await encryptSnapshot({...nextParams, writerPrivateKey: new Uint8Array(randomBytes(32))});
    expect((await put(wrongWriter.envelope)).status).toBe(403);
    const wrongPackage = await encryptSnapshot({...nextParams, packageDigest: base64url(randomBytes(32))});
    expect((await put(wrongPackage.envelope)).status).toBe(403);
    const winners = await Promise.all([put(next.envelope), put(next.envelope)]);
    expect(winners.map((r) => r.status).sort()).toEqual([204, 409]);
    const recovery = await fetch(`${apiOrigin}/v1/rooms/${room}/recover`, {method: 'POST',
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(editor)}, body: '{}'});
    expect(recovery.status).toBe(503);
  });
  beforeAll(async () => {
    const testRoot = join(ROOT, '.wrangler');
    await mkdir(testRoot, {recursive: true});
    temporaryDirectory = await mkdtemp(join(testRoot, 'phase3-do-'));
    const entry = join(temporaryDirectory, 'worker.mjs');
    await build({
      configFile: false,
      root: ROOT,
      build: {
        lib: {entry: resolve(ROOT, 'apps/api/src/do-test-worker.ts'), formats: ['es'], fileName: () => 'worker.mjs'},
        outDir: temporaryDirectory,
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
        sourcemap: false,
        rollupOptions: {external: ['cloudflare:workers']},
      },
      logLevel: 'silent',
    });

    miniflare = new Miniflare({
      modules: true,
      scriptPath: entry,
      name: WORKER_NAME,
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

    const url = await miniflare.ready;
    apiOrigin = url.origin;
  });

  afterAll(async () => {
    await miniflare?.dispose();
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  });

  it('reads room metadata with valid viewer capability', async () => {
    const room = roomId(0x51);
    const viewer = capability(0x52);
    const editor = capability(0x53);

    const init = await initializeRoom(room, viewer, editor);
    expect(init.status).toBe(201);

    const metaRes = await fetch(`${apiOrigin}/v1/rooms/${room}`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });

    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json();
    expect(meta.roomId).toBe(room);
    expect(meta.stateEpoch).toBe(0);
    expect(meta.revision).toBe(1);
    expect(meta.isRevoked).toBe(false);
  });

  it('rotates room capability links atomically and invalidates old capabilities', async () => {
    const room = roomId(0x61);
    const viewer1 = capability(0x62);
    const editor1 = capability(0x63);
    const viewer2 = capability(0x64);
    const editor2 = capability(0x65);

    await initializeRoom(room, viewer1, editor1);

    // Old viewer can read state
    const readOld = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer1), Origin: CONTROLLER_ORIGIN},
    });
    expect(readOld.status).toBe(200);

    // Rotate links using editor1 authority
    const rotateRes = await fetch(`${apiOrigin}/v1/rooms/${room}/rotate-links`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor1),
        'Content-Type': 'application/json',
        Origin: CONTROLLER_ORIGIN,
      },
      body: JSON.stringify({
        viewerCapHash: capabilityHash(viewer2),
        editorCapHash: capabilityHash(editor2),
      }),
    });
    expect(rotateRes.status).toBe(200);

    // Old viewer is now rejected (403)
    const readOldAfter = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer1), Origin: CONTROLLER_ORIGIN},
    });
    expect(readOldAfter.status).toBe(403);

    // New viewer can read state
    const readNew = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer2), Origin: CONTROLLER_ORIGIN},
    });
    expect(readNew.status).toBe(200);
  });

  it('revokes room and rejects all future capability accesses', async () => {
    const room = roomId(0x71);
    const viewer = capability(0x72);
    const editor = capability(0x73);

    await initializeRoom(room, viewer, editor);

    // Revoke using editor authority
    const revokeRes = await fetch(`${apiOrigin}/v1/rooms/${room}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor),
        Origin: CONTROLLER_ORIGIN,
      },
    });
    expect(revokeRes.status).toBe(200);

    // Future state read is rejected
    const readAfter = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });
    expect(readAfter.status).toBe(403);
  });

  it('freezes room on request-repair and recovers forward to new epoch', async () => {
    const room = roomId(0x81);
    const viewer = capability(0x82);
    const editor = capability(0x83);

    await initializeRoom(room, viewer, editor, Uint8Array.of(1, 2, 3));

    // Request repair
    const repairRes = await fetch(`${apiOrigin}/v1/rooms/${room}/request-repair`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor),
        Origin: CONTROLLER_ORIGIN,
      },
    });
    expect(repairRes.status).toBe(200);

    // Recover forward to epoch 1
    const recoverRes = await fetch(`${apiOrigin}/v1/rooms/${room}/recover`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor),
        'Content-Type': 'application/json',
        Origin: CONTROLLER_ORIGIN,
      },
      body: JSON.stringify({
        newEpoch: 1,
        ciphertext: base64url(Uint8Array.of(9, 9, 9)),
      }),
    });
    expect(recoverRes.status).toBe(200);
    const recovered = await recoverRes.json();
    expect(recovered.epoch).toBe(1);
    expect(recovered.revision).toBe(1);

    // Read state in new epoch
    const stateRes = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });
    expect(stateRes.status).toBe(200);
    expect(stateRes.headers.get('X-Smallframe-State-Epoch')).toBe('1');
    expect(stateRes.headers.get('X-Smallframe-Revision')).toBe('1');
  });
});
